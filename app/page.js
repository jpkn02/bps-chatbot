"use client";

import { useEffect, useRef, useState } from "react";

// Must match HARD_LIMIT_MIN in app/api/chat/route.js
const HARD_LIMIT_MIN = 15;

// How many further messages a participant may send after the session ends.
const MESSAGES_ALLOWED_AFTER_END = 2;

// Idle nudges, measured from the last keystroke. Anyone actively typing resets
// the clock, so a long answer is never interrupted; a half-finished sentence
// left sitting for 75s still gets help. The nudge never clears their draft.
const NUDGE_DELAYS_MS = [75000, 90000];

// The six section headers the bot emits, in order. Must match the header text
// in app/api/chat/system-prompt.txt — they drive the progress bar.
const SECTIONS = [
  { header: "Phase 1: Introduction", label: "Intro" },
  { header: "Phase 2: Your Professional Life", label: "Professional" },
  { header: "Phase 3: Your Social Life", label: "Social" },
  { header: "Phase 4: Your Leisure and Interests", label: "Leisure" },
  { header: "Phase 5: Your Personal Well-being", label: "Well-being" },
  { header: "Phase 6: Conclusion", label: "Conclusion" },
];

// Renders ***bold italic***, **bold**, and "- " / "* " bullet lines.
// Deliberately minimal.
function renderInline(text, keyPrefix) {
  return text
    .split(/(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*)/g)
    .map((part, i) => {
      const key = keyPrefix + i;
      if (part.startsWith("***") && part.endsWith("***")) {
        return (
          <strong key={key}>
            <em>{part.slice(3, -3)}</em>
          </strong>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={key} style={styles.headerText}>
            {part.slice(2, -2)}
          </strong>
        );
      }
      return <span key={key}>{part}</span>;
    });
}

function MessageBody({ text }) {
  return text.split("\n").map((line, i) => {
    if (line.trim() === "") return <div key={i} style={styles.blankLine} />;

    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      return (
        <div key={i} style={styles.bulletRow}>
          <span style={styles.bulletDot}>•</span>
          <span>{renderInline(trimmed.slice(2), `b${i}-`)}</span>
        </div>
      );
    }

    return <div key={i}>{renderInline(line, `l${i}-`)}</div>;
  });
}

export default function Home() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "Hi there, I'm your Future Reflection Guide. To begin, could you please enter the start code from your Qualtrics survey page?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [concluded, setConcluded] = useState(false);
  const [postEndCount, setPostEndCount] = useState(0);

  const [lastActivity, setLastActivity] = useState(Date.now());
  const [nudgeCount, setNudgeCount] = useState(0);

  const scrollRef = useRef(null);
  const autoEndRef = useRef(false);

  // Tick the countdown once a second, only while a session is running.
  useEffect(() => {
    if (!startedAt || concluded) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, concluded]);

  // When the clock runs out, fetch the conclusion without waiting for the
  // participant to send anything — otherwise someone who stops typing before
  // the end would never receive their end code.
  useEffect(() => {
    if (!startedAt || concluded || loading) return;
    if (remainingMs > 0 || autoEndRef.current) return;
    autoEndRef.current = true;

    // Anything still sitting unsent in the box is submitted before the session
    // closes, so a participant typing at 15:00 does not lose their last answer.
    const draft = input.trim();
    const finalMessages = draft
      ? [...messages, { role: "user", content: draft }]
      : messages;
    if (draft) {
      setInput("");
      setMessages(finalMessages);
    }

    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: finalMessages,
            elapsedMs: HARD_LIMIT_MIN * 60000,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setMessages([
          ...finalMessages,
          { role: "assistant", content: data.reply },
        ]);
        if (data.concluded) setConcluded(true);
      } catch (err) {
        setMessages([
          ...finalMessages,
          { role: "assistant", content: "⚠️ Error: " + err.message },
        ]);
      } finally {
        setLoading(false);
      }
    })();
  });

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const elapsedMs = startedAt ? now - startedAt : 0;
  const remainingMs = Math.max(0, HARD_LIMIT_MIN * 60000 - elapsedMs);
  const mm = String(Math.floor(remainingMs / 60000)).padStart(2, "0");
  const ss = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0");

  const locked = concluded && postEndCount >= MESSAGES_ALLOWED_AFTER_END;

  // Furthest section header seen anywhere in the transcript.
  const transcript = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n");
  let sectionIndex = -1;
  SECTIONS.forEach((s, i) => {
    if (transcript.includes(s.header)) sectionIndex = i;
  });

  // A fresh phase gets a fresh nudge allowance.
  useEffect(() => {
    setNudgeCount(0);
    setLastActivity(Date.now());
  }, [sectionIndex]);

  // Nudge a participant who has gone quiet with the box empty.
  useEffect(() => {
    if (!startedAt || concluded || locked || loading) return;
    if (nudgeCount >= NUDGE_DELAYS_MS.length) return;

    const id = setInterval(async () => {
      if (Date.now() - lastActivity < NUDGE_DELAYS_MS[nudgeCount]) return;
      setNudgeCount((n) => n + 1);
      setLastActivity(Date.now());
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            elapsedMs: Date.now() - startedAt,
            nudge: true,
          }),
        });
        const data = await res.json();
        if (data.skip || data.error || !data.reply) return;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply },
        ]);
      } catch {
        // a failed nudge is not worth surfacing to the participant
      }
    }, 5000);
    return () => clearInterval(id);
  }, [
    startedAt,
    concluded,
    locked,
    loading,
    nudgeCount,
    lastActivity,
    messages,
  ]);

  async function sendMessage(e) {
    e.preventDefault();
    if (!input.trim() || loading || locked) return;

    const sentAt = Date.now();
    setLastActivity(sentAt);
    if (concluded) setPostEndCount((n) => n + 1);

    const nextMessages = [...messages, { role: "user", content: input }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          elapsedMs: startedAt ? sentAt - startedAt : 0,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setMessages([...nextMessages, { role: "assistant", content: data.reply }]);
      // The clock starts from the message that carried a valid start code.
      if (data.started && !startedAt) {
        setStartedAt(sentAt);
        setNow(Date.now());
      }
      if (data.concluded) setConcluded(true);
    } catch (err) {
      setMessages([
        ...nextMessages,
        { role: "assistant", content: "⚠️ Error: " + err.message },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>Future Reflection Guide</h1>

        <div style={styles.headerRight}>
          <div style={styles.progressRow}>
            {SECTIONS.map((s, i) => (
              <div
                key={s.header}
                title={s.header}
                style={{
                  ...styles.segment,
                  ...(i < sectionIndex ? styles.segmentDone : {}),
                  ...(i === sectionIndex ? styles.segmentActive : {}),
                }}
              />
            ))}
          </div>
          <div style={styles.progressMeta}>
            <span>
              {sectionIndex < 0
                ? "Not started"
                : `${SECTIONS[sectionIndex].label} · ${sectionIndex + 1} of ${
                    SECTIONS.length
                  }`}
            </span>
            {startedAt && !concluded && (
              <span
                style={{
                  ...styles.timer,
                  ...(remainingMs < 180000 ? styles.timerLow : {}),
                }}
              >
                {mm}:{ss} left
              </span>
            )}
            {concluded && <span style={styles.done}>Complete</span>}
          </div>
        </div>
      </header>

      <div style={styles.window} ref={scrollRef}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.bubble,
              ...(m.role === "user" ? styles.user : styles.assistant),
            }}
          >
            <MessageBody text={m.content} />
          </div>
        ))}

        {loading && <div style={styles.thinking}>Thinking…</div>}
      </div>

      <form onSubmit={sendMessage} style={styles.form}>
        <textarea
          style={{ ...styles.input, ...(locked ? styles.inputLocked : {}) }}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setLastActivity(Date.now());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) sendMessage(e);
          }}
          placeholder={
            locked
              ? "This session has ended."
              : "Type your response… (Shift+Enter for a new line)"
          }
          rows={3}
          disabled={locked}
        />
        <button
          style={{ ...styles.button, ...(locked ? styles.buttonLocked : {}) }}
          type="submit"
          disabled={loading || locked}
        >
          Send
        </button>
      </form>

    </main>
  );
}

// ---------------------------------------------------------------------------
// APPEARANCE — safe to edit. Nothing here affects how the bot behaves, and
// none of it is ever sent to OpenAI, so it cannot change your token usage.
// Change a value, save, refresh the browser. If the page ever goes blank you
// have broken the syntax: undo with Cmd+Z and save again.
// Colours accept hex ("#0070f3") or names ("darkslateblue").
// ---------------------------------------------------------------------------
const THEME = {
  font: "Georgia, 'Times New Roman', serif",
  pageBackground: "#f6f9fb", // very pale blue-grey
  chatBackground: "#eaf0f5", // soft blue-tinted panel
  chatBorder: "#d5dee6",

  text: "#1f2b33", // slate
  mutedText: "#5d6c79",

  botBubble: "#ffffff",
  botText: "#1f2b33",
  userBubble: "#2e7d7b", // muted teal
  userText: "#ffffff",

  accent: "#2e7d7b",
  accentText: "#ffffff",
  progressDone: "#a3ccca",
  progressTodo: "#d7e0e8",

  timerLow: "#b3261e",
  complete: "#2f6f4f",

  bubbleRadius: 14,
  fontSize: 15, // message body text
  headerSize: 18, // the bold phase headers
};

const styles = {
  page: {
    maxWidth: 900,
    margin: "0 auto",
    padding: "20px 24px 28px",
    fontFamily: THEME.font,
    background: THEME.pageBackground,
    height: "100vh",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 14,
    gap: 20,
    flexWrap: "wrap",
  },
  title: { fontSize: 24, color: THEME.text, margin: 0 },
  headerRight: { display: "flex", flexDirection: "column", gap: 6, minWidth: 220 },
  progressRow: { display: "flex", gap: 4 },
  segment: {
    width: 34,
    height: 6,
    borderRadius: 3,
    background: THEME.progressTodo,
    transition: "background 250ms",
  },
  segmentDone: { background: THEME.progressDone },
  segmentActive: { background: THEME.accent },
  progressMeta: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 13,
    color: THEME.mutedText,
  },
  timer: { fontVariantNumeric: "tabular-nums" },
  timerLow: { color: THEME.timerLow, fontWeight: 600 },
  done: { color: THEME.complete, fontWeight: 600 },
  window: {
    border: `1px solid ${THEME.chatBorder}`,
    borderRadius: 12,
    padding: 20,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    background: THEME.chatBackground,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  bubble: {
    padding: "12px 16px",
    borderRadius: THEME.bubbleRadius,
    maxWidth: "82%",
    lineHeight: 1.5,
    fontSize: THEME.fontSize,
  },
  user: { background: THEME.userBubble, color: THEME.userText, alignSelf: "flex-end" },
  assistant: { background: THEME.botBubble, color: THEME.botText, alignSelf: "flex-start" },
  headerText: {
    display: "inline-block",
    fontSize: THEME.headerSize,
    marginBottom: 2,
  },
  blankLine: { height: 10 },
  bulletRow: { display: "flex", gap: 8, margin: "3px 0" },
  bulletDot: { flexShrink: 0 },
  thinking: { color: THEME.mutedText, fontStyle: "italic" },
  form: { display: "flex", gap: 8, marginTop: 12, alignItems: "stretch" },
  input: {
    flex: 1,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid #ccc",
    fontSize: 16,
    fontFamily: "inherit",
    color: THEME.text,
    background: "#fff",
    resize: "vertical",
  },
  inputLocked: { background: "#f0f0f0", color: "#888" },
  button: {
    padding: "12px 26px",
    borderRadius: 10,
    border: "none",
    background: THEME.accent,
    color: THEME.accentText,
    fontSize: 16,
    cursor: "pointer",
  },
  buttonLocked: { background: "#bbb", cursor: "not-allowed" },
  wordCount: { marginTop: 6, fontSize: 13, color: THEME.mutedText, textAlign: "right" },
};
