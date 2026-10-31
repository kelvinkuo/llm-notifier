# Gemini completion detection evidence (2026-10-30)

Checked the signed-in Codex browser with non-sensitive test prompts only. No response
text is read, stored, or sent by the detector. Historical private chats were not opened.

## Observed DOM

- Empty composer: `div[role="textbox"][contenteditable="true"]`, accessible name
  `Enter a prompt for Gemini`; a button named `Dictate (⌘⇧D)` is present. No send button.
- Draft: `button[aria-label="Send message"]` appears (no explicit type attribute).
- Submitted/generating: `button[aria-label="Stop response"]` appears, enabled.
- Flash and Pro use these same control names. Pro long-answer streaming was sampled:
  latest `model-response` has `message-content [aria-busy="true"]` and no `message-actions`.
- Finished: stop disappears; input and Dictate remain. Latest content has
  `aria-busy="false"`; `message-actions` contains
  `[data-test-id="thumb-up-button"]` (accessible name Good response), Bad response,
  Redo, and Copy. The actions element has a nonempty client rect and no hidden ancestor.
- Explicit stop: stop disappears and content eventually becomes `aria-busy="false"`,
  but that stopped response has no normal answer action footer.
- Refresh: responses can initially be absent, then historical `model-response` elements
  return with busy=false and footers. New chat removes all responses and uses `/app`.
  The test conversation could be reopened after new chat and rendered the same history.
- First submission changes `/app` to `/app/<id>`. Other conversation navigation resets tracking.

These are sampled observations, not proof that no transient state ever occurs. Real
server failures and every thinking/tool mode were not induced. Only the observed English
control labels are supported; unknown/localized UI fails closed rather than using guessed
selectors. The `role=alert` failure check is a defensive ARIA guard, not a claim that a
specific Gemini failure UI was reproduced.

## Detection and playback

A captured send/Enter arms a local turn, followed by observed stop/busy. Completion needs
all of: composer ready, stop absent, new response content busy=false, normal answer footer,
and one second of stable response mutations. The timer re-reads live DOM before emitting. A next explicit submission with the same
ready footer confirms the prior pending completion, so rapid follow-ups do not lose a sound.
Missing signals cancel settling; prolonged streaming silence alone cannot complete a turn.
Stop input, errors, navigation, and page teardown invalidate the turn. Loading history
never arms one. Input re-rendering does not replace the document observer.

The former provider played on any HTTP-200 POST matching `*/StreamGenerate*`; it could
neither validate UI completion nor distinguish stop/failure/history. The browser inspection
did not capture extension webRequest events, so endpoint changes or missed network events
are not asserted as a proven cause. This network completion trigger is now removed.

Each tab runs its own controller. Background deduplication uses tab/document and sequence,
with session fallback, in bounded memory. No global cooldown. The shared worker serializes
offscreen creation and sends explicit playback messages, awaiting each ended/error result.
Offscreen queues playback too, reuses the document, and releases failed/timed-out items.
Previously each notification closed the existing document, allowing concurrent sounds to
be interrupted. The actual notify.mp3 exists and decodes as a 1.176-second MP3; the stale
manifest resource name notification.mp3 was corrected. Audible playback in Chrome remains
part of manual acceptance; Codex's browser does not run this unpacked extension.

## Minimal Chrome acceptance

1. Reload the unpacked extension at chrome://extensions, then refresh Gemini tabs.
2. Submit two successive questions (try Flash and Pro). Each answer should sound once,
   after completion; long thinking/streaming should remain silent.
3. Submit long questions in two tabs, leave them in the background, and let both finish.
   Expect two complete sounds, sequential if completion times overlap.
4. Stop a long answer, refresh, open history, and create a new chat. Expect no sound
   from these operations; a subsequent normal question should notify again.
5. If a generation fails naturally, expect no completion sound. Inspect the extension
   worker console for explicit playback errors if a normal answer stays silent.
