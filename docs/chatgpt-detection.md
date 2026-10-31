# ChatGPT anonymous-page detection evidence (2026-10-30)

Inspected the user-opened, signed-out Chinese ChatGPT page and sent two harmless test
prompts (an integer list and a prime-number tutorial). No private chat was opened.

Observed:

- Composer is `textarea#mobile-composer-prompt`, marked `data-mobile-composer-prompt`,
  under a form and `data-composer-layout`. It is not contenteditable.
- Empty input still has a `button[aria-label="发送消息"]` with
  `aria-disabled="true"`; native disabled is false. Empty send is an idle state.
- Generation uses `button[aria-label="停止生成"]`; normal completion restores send.
  Dictation remains present during generation. The voice entry is an anchor and can
  remain hidden, so dictation/voice presence alone is not completion evidence.
- Main transcript turns are `li[data-message-role="user"]` and
  `li[data-message-role="assistant"]` with message ids in their `id` attributes.
- User bubble marker is presence-only: `data-user-message-bubble=""`.
- Assistant placeholders appear before content. While streaming, the assistant lacks
  `data-message-complete`; after completion this presence-only attribute appears.
  `data-assistant-content-started` can appear earlier and does not mean completion.
- A nested region can already have `aria-busy="false"` during generation; that alone
  is insufficient. Long-answer sampling confirmed the terminal marker remained absent
  until completion.
- Initial submission promotes `/` to `/uc/<id>` for the signed-out conversation.

The old adapters did not recognize this textarea or either role-bearing turn. The old
URL classifier recognized `/c/<id>` only, so anonymous promotion could cancel the turn.

Changes are confined to ChatGPT content-script adapters, completion URL classification,
and tests. Existing legacy selectors and completion policy are retained. Current
role-bearing assistant turns additionally block completion until their terminal marker
appears, and the observer watches that attribute even when no text changes. The composer
may be outside the transcript; its separate observer remains in use. Gemini and shared
notification playback are unchanged by this follow-up.

Regression coverage includes complete script startup, two rounds, first-route promotion,
attribute-only completion, long quiet streaming, placeholder replacement, loaded history,
hidden stale controls, independent tabs, and existing legacy fixtures. The browser page
provided DOM evidence; audible extension playback remains for local Chrome acceptance.
Only the signed-out Chinese page was inspected live, not the signed-in interface.

To accept: reload the extension, refresh each open ChatGPT tab, submit two questions,
and confirm one sound per completed answer. Try a long answer and a background tab;
there should be no sound while stop remains or the terminal marker is absent.
