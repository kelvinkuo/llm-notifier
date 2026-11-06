# Current diagnostics — 1.6.0

ChatGPT now observes page controls only. The investigations below describe retired
1.5.x code; their route/message/network events are no longer part of the detector.
See [current detection rules](chatgpt-detection.md).

Filter both the ChatGPT page Console and extension Service Worker Console by
`LLM Notifier`. Reload extension, refresh page, and submit a harmless question.
Current page events:

- CONTENT_SCRIPT_LOADED / DETECTOR_READY: boot, version, worker handshake.
- UI_STATE_CHANGED: ACTIVE / READY / UNKNOWN and recognized control type.
- GENERATION_STARTED: start of a locally observed generating cycle.
- STATE_CHANGED: IDLE -> GENERATING -> SETTLING -> IDLE, including interrupted settling.
- COMPLETION_CONFIRMED / PLAY_SOUND_SENT: stable idle, one message per cycle.
- PLAY_SOUND_ACK / PLAY_SOUND_FAILED: worker playback result.
- INIT_FAILED / DETECTION_FAILED / READY_FAILED: initialization or bridge errors.

The worker retains PLAY_SOUND_RECEIVED and existing OFFSCREEN_*/AUDIO_PLAY_* events.
AUDIO_PLAY_SUCCEEDED acknowledges ended playback, rather than merely dispatch.
Logs correlate by diagnosticId, tabId, sequence and timestamp. The page does not
log URL, conversation identities, prompts, responses, or each DOM mutation.
A sequence counts observed page generation cycles only. There is no route reset,
network-failure latch, history baseline, or per-conversation recovery state.

## Historical investigation (retired implementation)

# ChatGPT local diagnostic run

This round enables diagnostics only. Existing uncommitted work is retained. No
selector, completion rule, timer duration, or Gemini detector is changed. Logs are
local console output only, with no persistence or external upload.

## Files changed this round

- content_scripts/chatgpt/detector.js (CHATGPT_DEBUG, boot/handshake, state-change and input diagnostics)
- content_scripts/chatgpt/detector.test.js (diagnostic lifecycle/privacy regression)
- background/providers/chatgpt.js (worker receipt and correlation metadata)
- background/service-worker.js (ready acknowledgment and offscreen diagnostic forwarding)
- background/service-worker.test.js (handshake/forwarding/privacy regression)
- background/notification-player.js (queue/create/reuse/dispatch/result diagnostics)
- background/notification-player.test.js (audio event correlation and failure regressions)
- background/chatgpt-network-diagnostics.js (limit enabled diagnostics to relevant requests; sanitize URLs)
- offscreen/offscreen.js (mirror actual audio-start/accepted events to the worker)
- offscreen/playback-queue.js (observational audio callbacks only)
- shared/logger.js (DEBUG=true, timestamps, error URL redaction)
- docs/chatgpt-diagnostics.md (this guide)

Manifest and ChatGPT completion-machine.js were inspected and left unchanged this round.
Gemini detector/provider hashes were checked unchanged from the beginning of this round.

## Collect one run

1. At chrome://extensions reload LLM 响应通知器. Open its Service Worker Console.
2. Open DevTools Console on the local, signed-in chatgpt.com page. Check all log
   levels, enable Preserve log, and turn off "Selected context only" if enabled.
3. Filter BOTH consoles by `LLM Notifier`. Refresh the ChatGPT page after extension
   reload. Keep both consoles open for this run. No offscreen inspector is needed.
4. Submit one harmless prompt, for example "请分五点解释为什么天空呈蓝色".
   Wait until the answer visibly finishes, then observe for about 3 seconds.
   This is a manual observation interval, not a new detector timeout.
5. Copy only the filtered extension log lines from page reload through that point,
   including errors and JSON/object metadata. Label the two outputs "page" and
   "worker". Do not send your prompt/response or unrelated website errors.
6. Report whether a sound played. If a console has zero matching lines, explicitly
   say which one; check that it still has no lines with the filter removed.

The first page boot can have tabId=null. Once DETECTOR_READY is acknowledged it has
the tab id. diagnosticId links boot to the worker; tabId + diagnosticId + sequence
links a completed turn to offscreen creation/playback. No prompt or response text,
cookies, tokens, or URL query/hash are included. Relevant network logs strip URL
query/hash; general page XHRs are not logged. Streaming chunk mutation events are
suppressed; DETECTOR_STATE prints only when observed state/counts change.

## Locate the missing link (wait for actual logs before fixing)

- A: no CONTENT_SCRIPT_LOADED after refresh, with Console filters/contexts checked:
  investigate injection/extension errors, enabled state, site access and matching URL.
- B: CONTENT_SCRIPT_LOADED/ROOT_FOUND present, but no USER_TURN_STARTED after sending:
  USER_INPUT_OBSERVED and DETECTOR_STATE show whether input/composer/messages were recognized.
- C: USER_TURN_STARTED without GENERATION_STARTED or GENERATING_ENTER:
  inspect composer states, message counts and signal evidence.
- D: active generation observed but no GENERATION_ENDED/COMPLETION_CONFIRMED:
  inspect DETECTOR_STATE, COMPLETION_BLOCKED, SETTLE_RESET and route/reset events.
- E: page COMPLETION_CONFIRMED/PLAY_SOUND_SENT without worker PLAY_SOUND_RECEIVED:
  inspect PLAY_SOUND_SEND_FAILED, worker startup errors and diagnosticId.
- F: PLAY_SOUND_RECEIVED present: follow NOTIFICATION_QUEUED, OFFSCREEN_CHECK,
  OFFSCREEN_CREATED (or OFFSCREEN_REUSED), OFFSCREEN_DISPATCH, AUDIO_PLAY_STARTED,
  AUDIO_PLAY_ACCEPTED and AUDIO_PLAY_SUCCEEDED/AUDIO_PLAY_FAILED.

AUDIO_PLAY_STARTED is the actual offscreen audio.play invocation.
AUDIO_PLAY_ACCEPTED means its promise resolved; AUDIO_PLAY_SUCCEEDED means audio
ended and the worker received the completion acknowledgment. This cannot prove
that speakers or system volume made the sound audible. AUDIO_PLAY_FAILED carries
the failing stage and error. READY_FAILED/INIT_FAILED distinguish initialization
and runtime-bridge errors. Existing controller event names not mapped to the names
above are retained for their decision evidence.

## First local log result and focused follow-up

The supplied page and worker logs share one diagnosticId and tabId. In log UTC:

- 09:03:04.349: send was recognized and sequence 1 armed.
- 09:03:04.936: composer ACTIVE, assistant detected, generation started.
- 09:03:07.732: a conversation-to-conversation route change has keptTurn=false;
  the controller resets. The raw conversation keys were deliberately redacted.
- 09:03:36.026: composer READY_EMPTY, but activeSequence is already null.
- No COMPLETION_CONFIRMED, PLAY_SOUND_SENT, or worker PLAY_SOUND_RECEIVED follows.

Thus tracking was lost at route reset before the sound pipeline was invoked. This
run neither proves nor disproves audio playback itself. A later RESPONSE_FAILED
arrives after reset and is not evidence that it caused that earlier reset.

The logs do not distinguish a real conversation URL replacement from an out-of-date
worker history notification. Do not preserve every conversation-to-conversation
route blindly, because real history navigation must still cancel tracking.

Follow-up adds ROUTE_OBSERVED and route-change source/live-key equality only. Each
key gets a session-local alias such as route-1; raw paths, ids, query/hash, prompts,
and responses are not logged. Sources distinguish initialization, pathname-snapshot,
dom-snapshot, worker-history-message, popstate, and navigatesuccess. Existing route
handling still receives exactly the same URL and is unchanged.

Reload the extension and refresh ChatGPT. Start one new chat, submit one harmless
prompt, and avoid switching chats while it generates. Send the page's filtered
extension logs, especially ROUTE_OBSERVED, route changed, reset reason, and
DETECTOR_STATE. Include whether you manually navigated. Worker logs are needed
again if PLAY_SOUND_SENT appears or worker-history-message has matchesLive=false.

## Second local log result: sound works on an uninterrupted turn, plus startup false positive

The second run starts at an existing conversation URL. It contains two distinct events:

- At 12:37:15 UTC an existing user/assistant pair hydrates after an initially empty
  baseline and root upgrade. No fresh input or response-request start preceded it.
  It was incorrectly armed via user_message and played at 12:37:17.
- At 12:37:25 a fresh Enter submission starts the next tracked sequence. Generation
  goes ACTIVE, later READY_EMPTY, confirms completion at 12:38:04, and reaches
  AUDIO_PLAY_SUCCEEDED at 12:38:05. There is no mid-generation route reset in this run.

Together with the first run, this shows a route-reset loss of tracking in the failed
case, successful sound playback when tracking survives, and a separate startup-history
false positive. The second run does not reproduce or identify the source of the first
run's conversation-to-conversation change; that defect is not claimed fixed.

Targeted startup fix: until an explicit send/Enter/regenerate or response-request start,
late-hydrating messages remain baseline only. Explicit input refreshes the baseline
before the page's submit handler runs. This has no grace-period timer, does not modify
route rules or audio behavior, and leaves Gemini unchanged. Tests cover delayed
history, root upgrade, startup in-progress response, first real submission, and a
network-confirmed send. Existing complete-script fixtures now explicitly simulate
submission before inserting a live response, instead of equating all DOM insertions
with new user activity.

Next manual check: reload extension, refresh a page with an old answer and verify no
startup sound. Submit a normal question there, then separately use New chat and submit
another question. Capture the filtered page logs if the latter stays silent, including
ROUTE_OBSERVED, route changed, reset reason, and DETECTOR_STATE. No browser login or
UI acceptance was performed by Codex for this follow-up.

## 1.5.3: confirmed internal new-chat URL replacement and live-root baseline fix

The 2026-10-31 local log confirms both reported and live route keys change together:
new draft -> provisional conversation (kept) -> another conversation key while the
composer is ACTIVE (previously reset). Source is navigatesuccess; the worker event
agrees with the live route, ruling out a delayed worker hint for this occurrence.
The user did not switch conversations during generation.

It also shows rootWatcher.start rebinding an already-upgraded conversation div with
replaced=false during ARMED. baselineRoot then records the pending response as known
history. GENERATION_STARTED appears but generationSeen remains false.

Targeted fixes:

- A turn begun on a draft can follow a subsequent conversation-id replacement only
  when the visible composer is ACTIVE and its single user-message identity exactly
  matches the active turn. Logs show keptTurn=true, reason=same_new_chat_user.
- After such a replacement, user-message continuity remains required. Empty remounts
  block completion; different history messages cancel the turn and refresh baseline.
- Explicit in-page navigation links and browser back/forward cancel tracking. Turns
  begun in existing conversations do not receive the new-chat route exception.
- Root watcher correctly marks direct rebinds as replacements. More importantly,
  root rebinding never overwrites a live turn's history baseline, regardless of the
  replacement flag.

Version is 1.5.3. Regressions reproduce the provisional/canonical route order with a
live root rebind, delayed history, pending/final response ids, empty remounts, real
history navigation, and exactly-once completion. No fixed wait was introduced;
existing 800ms settling is unchanged. Gemini, notification audio, and cross-session
tracking remain unchanged. Local Chrome acceptance is still required; no commit or
push was made for this fix.

## 1.5.4: stale-turn recovery and observer reconnection

The 2026-11-06 excerpt shows a fresh Enter still using sequence 10 and inheriting
networkFailedSeen=true from before that send, with no subsequent DOM lifecycle logs.
This demonstrates that the old turn has not been replaced; the excerpt does not prove
which DOM replacement occurred on the real page, or that every missed notification has
the same cause.

Two bugs were reproduced in tests before changes (both tests failed on 1.5.3):

1. A failed unfinished turn survives a new explicit submission from an idle composer,
   retaining sequence/failure flags instead of beginning a clean turn.
2. Replacing an ancestor of the transcript's watched parent AND the composer leaves
   both scoped observers disconnected. A parent-only observer cannot see replacement
   of its own ancestor, so this can remain silent without navigation/network callbacks.

Fixes retain existing selectors and completion rules:

- Explicit submissions and network hints refresh observer connections; a persistent
  document childList observer detects disconnected transcript/composer surfaces. It
  performs connectivity checks only and does not log individual mutations.
- Network hints schedule a fresh DOM snapshot; they never directly play sound.
- Explicit input on a ready composer recovers failed/stalled prior turns. A still-armed
  healthy submission is retained to avoid replacing the same pending send. A currently
  active composer does not trigger this recovery. Old content is baselined before a
  fresh sequence, so it cannot be mistaken for that sequence's response.
- SUBMISSION_CONTEXT records actual live composer/turn state for each submission;
  SUBMISSION_RECOVERY identifies replacement of a stuck turn; SURFACE_RESYNC reports
  observer reconnection. No prompt/response text or new fixed timer is added.

All 109 Node tests pass, including ancestor+composer replacement without network or
navigation, stale failure recovery, and hint-driven DOM refresh that stays silent
while generation is still active. Version 1.5.4 includes the still-uncommitted 1.5.3
changes. Gemini and shared audio code are unchanged. Chrome acceptance remains manual:
reload extension, refresh ChatGPT, ask two consecutive questions in the same session.
