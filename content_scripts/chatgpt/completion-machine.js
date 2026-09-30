(function () {
    "use strict";

    const DEFAULT_SETTLE_MS = 800;

    function createNetworkState() {
        return {
            started: false,
            streamEnded: false,
            finalizeSeen: false,
            prepareSeen: false,
            failed: false,
            requestOpen: false,
        };
    }

    function conversationKeyFromUrl(url) {
        try {
            const parsed = new URL(url);
            const parts = parsed.pathname.split("/").filter(Boolean);
            const index = parts.indexOf("c");
            if (index >= 0 && parts[index + 1]) {
                return `c:${parts[index + 1]}`;
            }
            return `path:${parsed.pathname}`;
        } catch {
            return "invalid";
        }
    }

    function isDraftKey(key) {
        return typeof key === "string" && key.startsWith("path:");
    }

    function createChatGPTCompletionController(options) {
        const settings = options || {};
        const settleMs = typeof settings.settleMs === "number" ? settings.settleMs : DEFAULT_SETTLE_MS;
        const now = typeof settings.now === "function" ? settings.now : function () { return Date.now(); };
        const schedule = typeof settings.schedule === "function"
            ? settings.schedule
            : function (fn, ms) { return setTimeout(fn, ms); };
        const cancel = typeof settings.cancel === "function"
            ? settings.cancel
            : function (id) { clearTimeout(id); };
        const onCompleted = typeof settings.onCompleted === "function" ? settings.onCompleted : function () {};
        const onDebug = typeof settings.onDebug === "function" ? settings.onDebug : function () {};

        let phase = "IDLE";
        let sequence = 0;
        let activeTurn = null;
        let closedTurn = null;
        let settleTimer = null;
        let pendingNetwork = createNetworkState();
        let currentKey = null;
        let hasRoute = false;
        let ignoreCurrentGeneration = false;
        let latchSuppressGeneration = false;
        let sawGeneratingUi = false;
        let baselineReady = false;
        let baselineStale = false;
        let knownUserIds = Object.create(null);
        let knownAssistantIds = Object.create(null);
        let lastView = null;
        let observedComposerState = null;

        function debug(event, meta) {
            onDebug(event, meta || {});
        }

        function clearSettle() {
            if (settleTimer !== null) {
                cancel(settleTimer);
                settleTimer = null;
            }
        }

        function reset(reason, behavior) {
            const optionsForReset = behavior || {};
            clearSettle();
            activeTurn = null;
            pendingNetwork = createNetworkState();
            lastView = null;
            phase = "IDLE";
            ignoreCurrentGeneration = false;
            sawGeneratingUi = false;
            if (optionsForReset.suppressVisibleGeneration) {
                latchSuppressGeneration = true;
            }
            if (baselineReady) {
                baselineStale = true;
            }
            debug("reset reason", { reason: reason });
        }

        function applyNetworkHint(bucket, hint) {
            if (hint === "RESPONSE_REQUEST_STARTED") {
                bucket.started = true;
                bucket.requestOpen = true;
                bucket.streamEnded = false;
                bucket.finalizeSeen = false;
                bucket.prepareSeen = false;
                return;
            }
            if (hint === "RESPONSE_STREAM_ENDED") {
                bucket.streamEnded = true;
                bucket.requestOpen = false;
                return;
            }
            if (hint === "FINALIZE_SEEN") {
                bucket.finalizeSeen = true;
                return;
            }
            if (hint === "PREPARE_SEEN") {
                bucket.prepareSeen = true;
                return;
            }
            if (hint === "RESPONSE_FAILED") {
                bucket.failed = true;
                bucket.requestOpen = false;
            }
        }

        function networkEventName(hint) {
            if (hint === "RESPONSE_REQUEST_STARTED") return "network conversation started";
            if (hint === "RESPONSE_STREAM_ENDED" || hint === "RESPONSE_FAILED") return "network conversation ended";
            if (hint === "FINALIZE_SEEN") return "finalize observed";
            if (hint === "PREPARE_SEEN") return "prepare observed";
            return "network hint ignored";
        }

        function canonicalizeComposerState(explicit) {
            if (explicit === "ACTIVE" || explicit === "active") return "ACTIVE";
            if (explicit === "READY_DRAFT" || explicit === "ready_draft") return "READY_DRAFT";
            if (explicit === "READY_EMPTY" || explicit === "ready_empty" || explicit === "IDLE" || explicit === "idle") return "READY_EMPTY";
            if (explicit === "UNKNOWN" || explicit === "unknown") return "UNKNOWN";
            return null;
        }

        function isGenerationIdle(state) {
            return state === "READY_EMPTY" || state === "READY_DRAFT";
        }

        function resolveComposerState(source) {
            const explicit = canonicalizeComposerState(source.composerState);
            if (explicit) {
                if (explicit === "UNKNOWN" && source.stopControl) return "ACTIVE";
                return explicit;
            }
            if (source.stopControl || source.generating) return "ACTIVE";
            return "UNKNOWN";
        }

        function normalizeIdList(value) {
            if (!Array.isArray(value)) {
                return [];
            }
            const ids = [];
            for (let i = 0; i < value.length; i += 1) {
                if (value[i]) ids.push(String(value[i]));
            }
            return ids;
        }

        function normalizeSnapshot(snapshot) {
            const source = snapshot || {};
            const assistantMessageIds = normalizeIdList(source.assistantMessageIds);
            const assistantMessageId = source.assistantMessageId
                ? String(source.assistantMessageId)
                : (assistantMessageIds.length ? assistantMessageIds[assistantMessageIds.length - 1] : null);
            if (assistantMessageId && assistantMessageIds.indexOf(assistantMessageId) === -1) {
                assistantMessageIds.push(assistantMessageId);
            }
            const latestAssistantId = assistantMessageIds.length
                ? assistantMessageIds[assistantMessageIds.length - 1]
                : assistantMessageId;
            return {
                generating: Boolean(source.generating),
                assistantPresent: Boolean(source.assistantPresent) || Boolean(assistantMessageId),
                assistantMessageId: assistantMessageId,
                assistantMessageIds: assistantMessageIds,
                latestAssistantId: latestAssistantId,
                userMessageIds: normalizeIdList(source.userMessageIds),
                assistantChanged: Boolean(source.assistantChanged),
                continueOffered: Boolean(source.continueOffered),
                activityBlocked: Boolean(source.activityBlocked),
                stopControl: Boolean(source.stopControl),
                composerState: resolveComposerState(source),
                composerPrimaryLabel: source.composerPrimaryLabel ? String(source.composerPrimaryLabel) : null,
                composerPrimaryType: source.composerPrimaryType ? String(source.composerPrimaryType) : null,
                conversationKey: source.conversationKey ? String(source.conversationKey) : null,
                rootTag: source.rootTag ? String(source.rootTag) : null,
                composerFound: Boolean(source.composerFound),
                rootSelector: source.rootSelector ? String(source.rootSelector) : null,
            };
        }

        function rememberIds(ids, bucket) {
            for (let i = 0; i < ids.length; i += 1) {
                bucket[ids[i]] = true;
            }
        }

        function armTurn(reason, userMessageId, behavior) {
            const optionsForArm = behavior || {};
            if (activeTurn && !activeTurn.completed && !activeTurn.generationSeen && !optionsForArm.allowSameAssistant) {
                if (userMessageId) activeTurn.userMessageId = userMessageId;
                activeTurn.armedBy = reason;
                return activeTurn;
            }
            if (activeTurn && !activeTurn.completed && activeTurn.generationSeen && reason !== "regenerate" && reason !== "user_message") {
                return activeTurn;
            }
            if (activeTurn && !activeTurn.completed && activeTurn.generationSeen && reason === "user_message" && userMessageId && userMessageId === activeTurn.userMessageId) {
                return activeTurn;
            }

            sequence += 1;
            clearSettle();
            activeTurn = {
                sequence: sequence,
                userMessageId: userMessageId || null,
                assistantMessageId: null,
                startedAt: now(),
                lastMutationAt: now(),
                generationSeen: false,
                completed: false,
                userStopped: false,
                allowSameAssistant: Boolean(optionsForArm.allowSameAssistant),
                stopSeen: false,
                busySeen: false,
                sawGenerationActive: false,
                idleAfterActive: false,
                composerActiveSeen: false,
                composerIdleAfterActiveSeen: false,
                lastComposerState: null,
                generationEndedAt: null,
                networkFailedSeen: false,
                composerLifecycle: null,
                blockReason: null,
                assistantContentSeen: false,
                pathKey: currentKey,
                armedBy: reason,
                network: pendingNetwork,
            };
            pendingNetwork = createNetworkState();
            phase = "ARMED";
            debug("USER_TURN_DETECTED", {
                sequence: sequence,
                reason: reason,
                userMessageId: userMessageId || null,
            });
            debug("TURN_ARMED", {
                sequence: sequence,
                reason: reason,
                userMessageId: userMessageId || null,
            });
            return activeTurn;
        }

        function absorbAssistants(view) {
            let created = false;
            const latestId = view.latestAssistantId;
            const latestIsNew = Boolean(latestId) && !knownAssistantIds[latestId];
            for (let i = 0; i < view.assistantMessageIds.length; i += 1) {
                knownAssistantIds[view.assistantMessageIds[i]] = true;
            }
            if (latestIsNew && activeTurn && !activeTurn.completed) {
                activeTurn.assistantMessageId = latestId;
                activeTurn.assistantContentSeen = true;
                activeTurn.lastMutationAt = now();
                if (!activeTurn.generationSeen) {
                    activeTurn.generationSeen = true;
                    phase = "GENERATING";
                    created = true;
                    debug("ASSISTANT_TURN_DETECTED", {
                        sequence: activeTurn.sequence,
                        messageId: latestId,
                    });
                    debug("GENERATING_ENTER", {
                        sequence: activeTurn.sequence,
                        messageId: latestId,
                    });
                    debug("GENERATION_SIGNAL", {
                        sequence: activeTurn.sequence,
                        signal: "assistant_created",
                        messageId: latestId,
                    });
                } else {
                    debug("GENERATION_SIGNAL", {
                        sequence: activeTurn.sequence,
                        signal: "assistant_rebound",
                        messageId: latestId,
                    });
                }
            }

            if (activeTurn && !activeTurn.completed && activeTurn.allowSameAssistant && !activeTurn.generationSeen && view.latestAssistantId && (view.assistantChanged || view.stopControl)) {
                activeTurn.assistantMessageId = view.latestAssistantId;
                activeTurn.generationSeen = true;
                activeTurn.assistantContentSeen = true;
                activeTurn.lastMutationAt = now();
                phase = "GENERATING";
                created = true;
                debug("ASSISTANT_TURN_DETECTED", {
                    sequence: activeTurn.sequence,
                    messageId: view.latestAssistantId,
                });
                debug("GENERATING_ENTER", {
                    sequence: activeTurn.sequence,
                    messageId: view.latestAssistantId,
                });
                debug("GENERATION_SIGNAL", {
                    sequence: activeTurn.sequence,
                    signal: "assistant_mutation",
                    messageId: view.latestAssistantId,
                });
            }

            if (activeTurn && !activeTurn.completed && activeTurn.generationSeen && view.assistantChanged && !created) {
                activeTurn.assistantContentSeen = true;
                activeTurn.lastMutationAt = now();
                debug("GENERATION_SIGNAL", {
                    sequence: activeTurn.sequence,
                    signal: "assistant_mutation",
                    messageId: activeTurn.assistantMessageId,
                });
            }
        }

        function noteActiveSignals(view) {
            if (!activeTurn || activeTurn.completed || !activeTurn.generationSeen) return;
            if (view.stopControl && !activeTurn.stopSeen) {
                activeTurn.stopSeen = true;
                debug("GENERATION_SIGNAL", {
                    sequence: activeTurn.sequence,
                    signal: "stop_control",
                });
            } else if (!view.stopControl && activeTurn.stopSeen) {
                activeTurn.stopSeen = false;
                debug("GENERATION_SIGNAL_LOST", {
                    sequence: activeTurn.sequence,
                    signal: "stop_control",
                });
            }
            if (view.activityBlocked && !activeTurn.busySeen) {
                activeTurn.busySeen = true;
                debug("GENERATION_SIGNAL", {
                    sequence: activeTurn.sequence,
                    signal: "aria_busy",
                });
            } else if (!view.activityBlocked && activeTurn.busySeen) {
                activeTurn.busySeen = false;
                debug("GENERATION_SIGNAL_LOST", {
                    sequence: activeTurn.sequence,
                    signal: "aria_busy",
                });
            }
        }

        function holdReason(view) {
            if (view.continueOffered) return "continue";
            if (view.activityBlocked) return "aria_busy";
            return "assistant turn missing";
        }

        function networkStillActive(network) {
            return Boolean(network && network.requestOpen);
        }

        function composerDebugMeta(view, sequence) {
            return {
                sequence: sequence,
                state: view.composerState,
                primaryLabel: view.composerPrimaryLabel || null,
                primaryType: view.composerPrimaryType || null,
            };
        }

        function fallbackEndEvidence(turn, view) {
            const network = turn.network;
            if (network && (network.streamEnded || network.finalizeSeen || network.prepareSeen)) return true;
            if (view && isGenerationIdle(view.composerState) && turn.assistantContentSeen) return true;
            return false;
        }

        function noteComposerLifecycle(view) {
            const state = view.composerState === "ACTIVE" || isGenerationIdle(view.composerState)
                ? view.composerState
                : "UNKNOWN";
            const turn = activeTurn && !activeTurn.completed ? activeTurn : null;
            const changed = state !== observedComposerState;
            const turnNeedsState = Boolean(turn && turn.lastComposerState !== state);
            if (!changed && !turnNeedsState) return;
            const previous = observedComposerState;
            observedComposerState = state;
            const sequence = turn ? turn.sequence : null;
            if (turn) {
                turn.lastComposerState = state;
                turn.composerLifecycle = state;
            }
            if (changed && previous) {
                debug("COMPOSER_TRANSITION", {
                    sequence: sequence,
                    from: previous,
                    to: state,
                    transition: previous + " -> " + state,
                    primaryLabel: view.composerPrimaryLabel || null,
                    primaryType: view.composerPrimaryType || null,
                });
            }
            debug("COMPOSER_STATE_" + state, composerDebugMeta(view, sequence));
            if (!turn) return;
            if (state === "ACTIVE") {
                turn.sawGenerationActive = true;
                turn.composerActiveSeen = true;
                turn.idleAfterActive = false;
                turn.composerIdleAfterActiveSeen = false;
                turn.generationEndedAt = null;
                if (phase === "ARMED" || phase === "COMPLETING" || phase === "IDLE") phase = "GENERATING";
                debug("GENERATION_ACTIVE_ENTER", {
                    sequence: turn.sequence,
                    composerState: "ACTIVE",
                });
                return;
            }
            if (isGenerationIdle(state)) {
                if (turn.composerActiveSeen || turn.sawGenerationActive) {
                    turn.idleAfterActive = true;
                    turn.composerIdleAfterActiveSeen = true;
                    turn.generationEndedAt = now();
                    debug("GENERATION_IDLE_ENTER", {
                        sequence: turn.sequence,
                        composerState: state,
                    });
                }
                return;
            }
            if (turn.composerActiveSeen || turn.sawGenerationActive) {
                turn.idleAfterActive = false;
                turn.composerIdleAfterActiveSeen = false;
                turn.generationEndedAt = null;
            }
        }

        function completionBlockReason(view) {
            if (view.composerState === "ACTIVE") return "generation_active";
            if (activeTurn.sawGenerationActive || activeTurn.composerActiveSeen) {
                if (!activeTurn.idleAfterActive && !activeTurn.composerIdleAfterActiveSeen) {
                    return "generation_active";
                }
                return null;
            }
            if (activeTurn.userStopped) return null;
            if (networkStillActive(activeTurn.network)) {
                return view.composerState === "UNKNOWN" ? "composer_unknown" : "no_generation_end_signal";
            }
            if (fallbackEndEvidence(activeTurn, view)) return null;
            if (view.composerState === "UNKNOWN") return "composer_unknown";
            return "no_generation_end_signal";
        }

        function completionPath(turn) {
            if ((turn.composerActiveSeen || turn.sawGenerationActive) && (turn.composerIdleAfterActiveSeen || turn.idleAfterActive)) {
                return "PRIMARY_COMPLETION_PATH";
            }
            return "FALLBACK_COMPLETION_PATH";
        }

        function startTurnSettle() {
            clearSettle();
            phase = "COMPLETING";
            const turn = activeTurn;
            debug("SETTLE_START", {
                sequence: turn.sequence,
                settleMs: settleMs,
            });
            settleTimer = schedule(function () {
                settleTimer = null;
                if (!activeTurn || activeTurn !== turn || turn.completed || phase !== "COMPLETING") {
                    debug("duplicate completion ignored", { sequence: turn.sequence });
                    return;
                }
                const blocked = lastView ? completionBlockReason(lastView) : null;
                if (blocked) {
                    phase = "GENERATING";
                    if (turn.blockReason !== blocked) {
                        turn.blockReason = blocked;
                        debug("COMPLETION_BLOCKED", {
                            sequence: turn.sequence,
                            reason: blocked,
                        });
                    }
                    return;
                }
                if (turn.pathKey && currentKey && currentKey !== turn.pathKey) {
                    const assignedNewChat = isDraftKey(turn.pathKey) && currentKey.startsWith("c:");
                    if (!assignedNewChat) {
                        reset("route change", { suppressVisibleGeneration: true });
                        return;
                    }
                }
                const payload = {
                    sequence: turn.sequence,
                    messageId: turn.assistantMessageId,
                    reason: turn.userStopped ? "USER_STOPPED" : "GENERATION_SETTLED",
                };
                turn.completed = true;
                closedTurn = {
                    sequence: turn.sequence,
                    assistantMessageId: turn.assistantMessageId,
                    completed: true,
                    failed: false,
                    duplicateLogged: false,
                };
                activeTurn = null;
                phase = "IDLE";
                sawGeneratingUi = false;
                debug("COMPLETED", payload);
                debug(completionPath(turn), {
                    sequence: turn.sequence,
                    messageId: turn.assistantMessageId,
                });
                try {
                    onCompleted(payload);
                } catch (error) {
                    debug("reset reason", { reason: "completion handler failed" });
                }
            }, settleMs);
        }

        function maybeSettleTurn(view) {
            if (!activeTurn || !activeTurn.generationSeen || activeTurn.completed) {
                noteDuplicate(view);
                return;
            }
            const held = view.activityBlocked
                || view.continueOffered
                || (!activeTurn.assistantMessageId && !activeTurn.userStopped);
            if (held) {
                if (settleTimer) {
                    clearSettle();
                    debug("SETTLE_RESET", {
                        sequence: activeTurn.sequence,
                        reason: holdReason(view),
                    });
                }
                phase = "GENERATING";
                return;
            }
            const blocked = completionBlockReason(view);
            if (blocked) {
                if (settleTimer) {
                    clearSettle();
                    debug("SETTLE_RESET", {
                        sequence: activeTurn.sequence,
                        reason: blocked,
                    });
                }
                phase = "GENERATING";
                if (activeTurn.blockReason !== blocked) {
                    activeTurn.blockReason = blocked;
                    debug("COMPLETION_BLOCKED", {
                        sequence: activeTurn.sequence,
                        reason: blocked,
                    });
                }
                return;
            }
            activeTurn.blockReason = null;
            if (view.assistantChanged && settleTimer) {
                debug("SETTLE_RESET", {
                    sequence: activeTurn.sequence,
                    reason: "assistant_mutation",
                });
                startTurnSettle();
                return;
            }
            if (!settleTimer) startTurnSettle();
        }

        function reconsiderCompletion() {
            if (!baselineReady || baselineStale || !lastView || !activeTurn || activeTurn.completed) return;
            maybeSettleTurn({
                continueOffered: lastView.continueOffered,
                activityBlocked: lastView.activityBlocked,
                assistantChanged: false,
                composerState: lastView.composerState,
                stopControl: lastView.stopControl,
                assistantMessageId: lastView.assistantMessageId,
            });
        }

        function noteDomFromTurns(view) {
            if (baselineStale) return;
            lastView = view;
            for (let i = 0; i < view.userMessageIds.length; i += 1) {
                const userId = view.userMessageIds[i];
                if (knownUserIds[userId]) continue;
                knownUserIds[userId] = true;
                armTurn("user_message", userId);
            }
            noteComposerLifecycle(view);
            absorbAssistants(view);
            noteActiveSignals(view);
            maybeSettleTurn(view);
        }

        function noteBaseline(snapshot) {
            const view = normalizeSnapshot(snapshot);
            knownUserIds = Object.create(null);
            knownAssistantIds = Object.create(null);
            rememberIds(view.userMessageIds, knownUserIds);
            rememberIds(view.assistantMessageIds, knownAssistantIds);
            baselineReady = true;
            baselineStale = false;
            debug("INIT", {
                userCount: view.userMessageIds.length,
                assistantCount: view.assistantMessageIds.length,
                latestAssistantId: view.latestAssistantId,
                rootTag: view.rootTag,
                rootSelector: view.rootSelector,
                composerFound: view.composerFound,
            });
        }

        function armNewTurn() {
            sequence += 1;
            activeTurn = {
                sequence: sequence,
                assistantMessageId: null,
                startedAt: now(),
                lastMutationAt: now(),
                generationSeen: true,
                completed: false,
                userStopped: false,
                pathKey: currentKey,
                network: pendingNetwork,
                sawGenerationActive: false,
                idleAfterActive: false,
                composerActiveSeen: false,
                composerIdleAfterActiveSeen: false,
                lastComposerState: null,
                generationEndedAt: null,
                networkFailedSeen: false,
                blockReason: null,
            };
            pendingNetwork = createNetworkState();
            phase = "GENERATING";
            debug("GENERATING entered", { sequence: sequence });
        }

        function trackAssistant(view) {
            if (!activeTurn || !view.assistantPresent) {
                return;
            }
            if (view.assistantMessageId && view.assistantMessageId !== activeTurn.assistantMessageId) {
                activeTurn.assistantMessageId = view.assistantMessageId;
                activeTurn.lastMutationAt = now();
                debug("assistant turn detected", {
                    sequence: activeTurn.sequence,
                    messageId: activeTurn.assistantMessageId,
                });
                return;
            }
            if (view.assistantChanged) {
                activeTurn.lastMutationAt = now();
                debug("assistant mutation", {
                    sequence: activeTurn.sequence,
                    messageId: activeTurn.assistantMessageId,
                });
            }
        }

        function noteDuplicate(view) {
            if (!closedTurn || !closedTurn.completed || closedTurn.failed || closedTurn.duplicateLogged) {
                return;
            }
            const messageId = view.latestAssistantId || view.assistantMessageId;
            if (!messageId || messageId !== closedTurn.assistantMessageId) {
                return;
            }
            closedTurn.duplicateLogged = true;
            debug("duplicate completion ignored", {
                sequence: closedTurn.sequence,
                messageId: view.assistantMessageId,
            });
        }

        function holdCompletion(view) {
            let reason = "assistant turn missing";
            if (view.continueOffered) {
                reason = "continue generating";
            } else if (view.activityBlocked) {
                reason = "activity in progress";
            }
            if (settleTimer) {
                clearSettle();
                debug("settle timer reset", {
                    reason: reason,
                    sequence: activeTurn.sequence,
                });
            }
            phase = "GENERATING";
        }

        function startSettle() {
            clearSettle();
            phase = "COMPLETING";
            const turn = activeTurn;
            debug("settle timer started", {
                sequence: turn.sequence,
                settleMs: settleMs,
            });
            settleTimer = schedule(function () {
                settleTimer = null;
                if (!activeTurn || activeTurn !== turn || turn.completed || phase !== "COMPLETING") {
                    debug("duplicate completion ignored", { sequence: turn.sequence });
                    return;
                }
                if (turn.pathKey && currentKey && currentKey !== turn.pathKey) {
                    const assignedNewChat = isDraftKey(turn.pathKey) && currentKey.startsWith("c:");
                    if (!assignedNewChat) {
                        reset("route change", { suppressVisibleGeneration: true });
                        return;
                    }
                }
                const payload = {
                    sequence: turn.sequence,
                    messageId: turn.assistantMessageId,
                    reason: turn.userStopped ? "USER_STOPPED" : "GENERATION_SETTLED",
                };
                turn.completed = true;
                closedTurn = {
                    sequence: turn.sequence,
                    assistantMessageId: turn.assistantMessageId,
                    completed: true,
                    failed: false,
                    duplicateLogged: false,
                };
                activeTurn = null;
                phase = "IDLE";
                sawGeneratingUi = false;
                debug("COMPLETED", payload);
                debug(completionPath(turn), {
                    sequence: turn.sequence,
                    messageId: turn.assistantMessageId,
                });
                try {
                    onCompleted(payload);
                } catch (error) {
                    debug("reset reason", { reason: "completion handler failed" });
                }
            }, settleMs);
        }

        function handleGenerating(view) {
            const canResume = activeTurn && !activeTurn.completed;
            if (!canResume) {
                armNewTurn();
            } else if (settleTimer) {
                clearSettle();
                phase = "GENERATING";
                debug("settle timer reset", {
                    reason: "generation resumed",
                    sequence: activeTurn.sequence,
                });
            } else {
                phase = "GENERATING";
            }
            sawGeneratingUi = true;
            trackAssistant(view);
        }

        function handleNotGenerating(view) {
            if (sawGeneratingUi && activeTurn && !activeTurn.completed) {
                debug("generation UI disappeared", { sequence: activeTurn.sequence });
            }
            sawGeneratingUi = false;

            if (!activeTurn || !activeTurn.generationSeen || activeTurn.completed) {
                noteDuplicate(view);
                return;
            }

            trackAssistant(view);

            if (view.continueOffered || view.activityBlocked || (!view.assistantPresent && !activeTurn.userStopped)) {
                holdCompletion(view);
                return;
            }

            if (view.assistantChanged && settleTimer) {
                debug("settle timer reset", {
                    reason: "assistant mutation",
                    sequence: activeTurn.sequence,
                });
            }
            if (!settleTimer || view.assistantChanged) {
                startSettle();
            }
        }

        function applyConversationKey(nextKey) {
            if (!hasRoute) {
                hasRoute = true;
                currentKey = nextKey;
                debug("page detected", { conversationKey: nextKey });
                return;
            }
            if (nextKey === currentKey) {
                return;
            }

            const previousKey = currentKey;
            const keepActiveTurn = isDraftKey(previousKey)
                && nextKey.startsWith("c:")
                && activeTurn
                && !activeTurn.completed;
            currentKey = nextKey;
            if (keepActiveTurn) {
                activeTurn.pathKey = nextKey;
                debug("route changed", {
                    from: previousKey,
                    to: nextKey,
                    keptTurn: true,
                });
                return;
            }

            debug("route changed", {
                from: previousKey,
                to: nextKey,
                keptTurn: false,
            });
            reset("route change", { suppressVisibleGeneration: true });
        }

        function noteRouteChange(url) {
            applyConversationKey(conversationKeyFromUrl(url));
        }

        function noteDom(snapshot) {
            const view = normalizeSnapshot(snapshot);
            if (view.conversationKey) {
                applyConversationKey(view.conversationKey);
            }
            if (baselineReady) {
                noteDomFromTurns(view);
                return;
            }

            // Legacy fallback; not primary detection path.
            // The content script establishes a baseline before the first snapshot,
            // so production turns use noteDomFromTurns. Pre-baseline DOM events still
            // settle through the older generating flag.

            if (latchSuppressGeneration) {
                latchSuppressGeneration = false;
                if (view.generating) {
                    ignoreCurrentGeneration = true;
                    debug("reset reason", { reason: "ignored generation already visible after route change" });
                    return;
                }
            }

            if (ignoreCurrentGeneration) {
                if (view.generating) {
                    return;
                }
                ignoreCurrentGeneration = false;
                sawGeneratingUi = false;
                debug("reset reason", { reason: "ignored generation ended" });
                return;
            }

            if (view.generating) {
                handleGenerating(view);
                return;
            }
            handleNotGenerating(view);
        }

        function noteNetwork(hint) {
            if (hint === "RESPONSE_FAILED" && activeTurn && !activeTurn.completed) {
                activeTurn.networkFailedSeen = true;
            }
            const liveSequence = activeTurn && !activeTurn.completed ? activeTurn.sequence : null;
            const failedSeen = Boolean(activeTurn && !activeTurn.completed && activeTurn.networkFailedSeen);
            if (hint === "RESPONSE_FAILED") {
                debug("RESPONSE_FAILED", {
                    failed: true,
                    networkFailedSeen: true,
                    sequence: liveSequence,
                });
            }
            if (baselineReady) {
                debug("GENERATION_SIGNAL", {
                    signal: "network_hint",
                    hint: hint,
                    failed: hint === "RESPONSE_FAILED",
                    networkFailedSeen: failedSeen,
                    sequence: liveSequence,
                });
                if (hint === "RESPONSE_REQUEST_STARTED" && (!activeTurn || activeTurn.completed) && !baselineStale) {
                    armTurn("network_hint", null);
                }
                if (!activeTurn || activeTurn.completed) {
                    if (hint !== "RESPONSE_FAILED") applyNetworkHint(pendingNetwork, hint);
                    return;
                }
                applyNetworkHint(activeTurn.network, hint);
                reconsiderCompletion();
                return;
            }

            debug(networkEventName(hint), {
                hint: hint,
                failed: hint === "RESPONSE_FAILED",
                networkFailedSeen: failedSeen,
                sequence: liveSequence,
            });

            if (!activeTurn || activeTurn.completed) {
                if (hint !== "RESPONSE_FAILED") {
                    applyNetworkHint(pendingNetwork, hint);
                }
                return;
            }

            applyNetworkHint(activeTurn.network, hint);
        }

        function noteUserTurnStarted(meta) {
            if (!baselineReady) {
                debug("user turn started", meta || {});
                return;
            }
            const source = meta && meta.source ? meta.source : "submit";
            if (source === "regenerate") {
                armTurn("regenerate", null, { allowSameAssistant: true });
                return;
            }
            if (!activeTurn || activeTurn.completed) {
                armTurn(source, null);
                return;
            }
            debug("USER_TURN_DETECTED", {
                sequence: activeTurn.sequence,
                reason: source,
                userMessageId: activeTurn.userMessageId,
            });
        }

        function noteUserStopped() {
            if (!activeTurn || activeTurn.completed || !activeTurn.generationSeen) {
                return;
            }
            activeTurn.userStopped = true;
            debug("user stopped", { sequence: activeTurn.sequence });
        }

        function suppressIfAlreadyGenerating(isGenerating) {
            if (!isGenerating) {
                return;
            }
            ignoreCurrentGeneration = true;
            sawGeneratingUi = false;
            debug("reset reason", { reason: "startup generation" });
        }

        function getState() {
            return {
                phase: phase,
                activeSequence: activeTurn ? activeTurn.sequence : null,
                generationSeen: Boolean(activeTurn && activeTurn.generationSeen),
                userStopped: Boolean(activeTurn && activeTurn.userStopped),
                networkFailedSeen: Boolean(activeTurn && activeTurn.networkFailedSeen),
                composerActiveSeen: Boolean(activeTurn && activeTurn.composerActiveSeen),
                lastComposerState: activeTurn ? activeTurn.lastComposerState : null,
            };
        }

        return {
            noteDom: noteDom,
            noteBaseline: noteBaseline,
            noteNetwork: noteNetwork,
            noteUserTurnStarted: noteUserTurnStarted,
            noteUserStopped: noteUserStopped,
            noteRouteChange: noteRouteChange,
            suppressIfAlreadyGenerating: suppressIfAlreadyGenerating,
            reset: reset,
            getState: getState,
        };
    }

    function createPlaySoundMessage(event) {
        return {
            action: "play_sound",
            provider: "ChatGPT",
            reason: event.reason,
            sequence: event.sequence,
            messageId: event.messageId,
        };
    }

    function createRootWatcher(options) {
        const settings = options || {};
        const queryRoot = settings.queryRoot;
        const observeUntilRoot = settings.observeUntilRoot;
        const observeParent = settings.observeParent;
        const onWaiting = settings.onWaiting || function () {};
        const onFound = settings.onFound || function () {};
        const onReplaced = settings.onReplaced || function () {};
        let bootstrap = null;
        let parentWatch = null;
        let bound = null;
        let nextBindIsReplacement = false;

        function disconnectParent() {
            if (parentWatch) {
                parentWatch.disconnect();
                parentWatch = null;
            }
        }

        function bind(root) {
            const replaced = nextBindIsReplacement;
            nextBindIsReplacement = false;
            disconnectParent();
            bound = root;
            if (bootstrap) {
                bootstrap.disconnect();
                bootstrap = null;
            }
            parentWatch = observeParent(root, function () {
                if (!bound || bound.isConnected === false) detach();
            });
            onFound(root, { replaced: replaced });
        }

        function detach() {
            nextBindIsReplacement = true;
            bound = null;
            disconnectParent();
            onReplaced();
            watch();
        }

        function watch() {
            const existing = queryRoot();
            if (existing && existing.isConnected !== false) {
                if (existing === bound) return;
                bind(existing);
                return;
            }
            if (bootstrap) return;
            onWaiting();
            bootstrap = observeUntilRoot(function () {
                const next = queryRoot();
                if (next && next.isConnected !== false) bind(next);
            });
        }

        return {
            start: watch,
            checkConnection: function () {
                if (bound && bound.isConnected === false) detach();
            },
        };
    }

    globalThis.ChatGPTCompletion = {
        DEFAULT_SETTLE_MS: DEFAULT_SETTLE_MS,
        createChatGPTCompletionController: createChatGPTCompletionController,
        conversationKeyFromUrl: conversationKeyFromUrl,
        createPlaySoundMessage: createPlaySoundMessage,
        createRootWatcher: createRootWatcher,
    };
})();
