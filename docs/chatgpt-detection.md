# ChatGPT page-level completion detection — 1.6.0

The goal is to sound once when generation observed in a tab ends. There is no
conversation ownership, message identity, route alignment, or network evidence.
Gemini detection and the shared serial audio queue are unchanged.

## Three states

- IDLE: known idle controls or no generation observed; no notification.
- GENERATING: a visible, recognized stop control is present. Stop outranks send/voice.
- SETTLING: stop has disappeared and a recognized send/voice control is visible.
  After 800ms, re-read live controls before sending exactly one completion event.

If stop returns, cancel settling and keep the same generation cycle. If controls
are absent/hidden/unknown, hold the generation and require a fresh stable idle
signal; absence alone is never completion evidence. A page initially showing stop
tracks that generation. An idle page with historical answers cannot arm a cycle.

Exact Chinese/English labels and existing stable test ids come from prior DOM
inspection. A disabled/aria-disabled empty send button is still a positive idle
signal. Dictation alone is not an idle signal. Hidden/aria-hidden/inert/disconnected
or CSS-hidden controls are excluded. Document visibility is not a completion gate,
so background tabs continue working.

One MutationObserver watches the document element, not transient transcript or
composer nodes. It watches child/attribute changes, and reads control attributes
and visibility only. It does not read prompts, response text, or message ids. The
browser batches observer delivery; there is no polling or generation timeout.

## Intentional tradeoffs

Switching from a generating conversation to an idle conversation may sound once.
Explicit Stop or failure restoring idle controls may also sound. The simplified
model deliberately does not distinguish these cases from normal completion, and
does not promise to track an offscreen/unmounted conversation to completion.
A brief stop disappearance shorter than settling is filtered, but no button-only
model can distinguish an extended idle-looking interruption from completion.

Per-tab generation cycles prevent duplicates. Existing background/offscreen queues
serialize simultaneous tabs' sounds. An audio failure is acknowledged and logged,
and cannot block tracking of the next generation. Sequence is just a local log
counter, not an answer or conversation identifier.

## Local acceptance

Reload the extension at chrome://extensions, then refresh all ChatGPT tabs. Confirm
CONTENT_SCRIPT_LOADED version 1.6.0. Ask once in an existing chat, then select New
chat and ask again without refreshing. Each observed generation should sound once
when stop disappears and idle stabilizes. Try a long Thinking answer, an input-area
remount, and two background tabs. Expect silence while stop remains or controls are
unknown. Switching to an idle chat may sound, by design.

No network/navigation listeners remain; manifest permissions now require offscreen
only. No Codex-browser UI acceptance, commit, push, or deployment is performed.
