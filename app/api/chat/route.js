import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Swap to "gpt-4o" here to test a stronger model.
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Session timing, in minutes. Change these to retune the session.
// The exercise is exactly 15 minutes long, timed from the moment the
// participant types Start. Both values are 15, so every session concludes at
// the same point: it cannot end earlier, and is forced to end there.
const HARD_LIMIT_MIN = 15;
const MIN_BEFORE_END_MIN = 15;

// Latest-start deadlines per domain — maximums, not targets. Starting a domain
// earlier is fine. Must line up with the schedule written into
// system-prompt.txt.
const DEADLINES = [
  { byMin: 3.5, stage: "Phase 3, Your Social Life" },
  { byMin: 7, stage: "Phase 4, Your Leisure and Interests" },
  { byMin: 10.5, stage: "Phase 5, Your Personal Well-being" },
];

// Depth targets. The model cannot count words reliably, so the server counts
// and tells it what to do.
const WORD_TARGET = 50; // words per domain before moving on
const SHORT_FIRST_TURN = 25; // below this, probe with a scene question
const MAX_PROBE_ROUNDS = 4; // escape hatch for disengaged participants
const NOTHING_TO_REFLECT = 15; // below this, skip the reflection entirely
// Thin first replies get a reminder to write more. Triggered on word count
// only: participants are told not to worry about grammar, so counting
// full stops would penalise anyone who writes without punctuation.

// Appended verbatim after the follow-up questions when a first reply is thin.
const DETAIL_REMINDER =
  "Please take your time and aim for three sentences or more, to give more detail about this part of your future life.";

// Must match the domain headers in system-prompt.txt.
// The clock starts when the participant types Start after this block.
const INTRO_HEADER = "Phase 1: Introduction";
const START_WORD = "start";

// Markers the model must use verbatim, so the server can tell which step of the
// spare-time sequence has already happened.
const INTERIM_INVITE =
  "Looking at this now, take your time and try to add onto what you've written about so far.";
const INTERIM_FOOTER =
  "Feel free to either copy and paste this text to make edits, or just type what you'd like to add on into the chat below.";
const INTERIM_MARKER = "Looking at this now, take your time";
const DAYLIFE_MARKER = "one ordinary day";
const HOLD_MARKER = "sit with what you have written";

// Off-task handling. The re-ask is fixed text, and its presence in the
// transcript is how later turns know which replies to discount.
const OFF_TASK_MARKER = "I didn't quite follow that";
const OFF_TASK_REPLY =
  "Sorry, I didn't quite follow that. Could you tell me a bit more about this part of your future?";
const MAX_OFF_TASK_REASKS = 2;

// "idk", "not sure", "no idea" — a sincere signal of being stuck, not nonsense
// and not a decline. Answered with reassurance and that phase's starter line.
const STUCK_CUES =
  /(^|\b)(idk|dk|dunno|no idea|no clue|i don'?t know|dont know|not sure|unsure|can'?t think|cant think|hmm+)(\b|$)/i;
const STUCK_MARKERS = [
  "there's no rush, and there's no right answer here",
  "It's okay to take your time",
];
const MAX_STUCK_HELPS = 3;

function isStuckReply(text) {
  return STUCK_MARKERS.some((m) => String(text).includes(m));
}

// The participant asking to drop a topic. Honoured in code: a refusal they have
// to repeat is a bad experience, and prompt wording alone did not hold.
const REFUSAL_CUES =
  /(don'?t|do not|dont) want to (talk|write|say)|something else|change the (subject|topic)|move on from|another topic|rather not|no more (about|on)|stop talking about|enough about/i;
const REDIRECT_MARKER = "we can leave that";
// Refusing a whole writing phase. They are moved on, and the phase counts as
// unwritten — which is what earns the incomplete end code.
const PHASE_REFUSAL_ACK = "That's alright, we can move on.";

// "are u AI", "what are you", "are you a real person". Answered honestly and
// identically for every participant, then redirected.
const IDENTITY_CUES =
  /\b(who|what)\s*(are|r|is)\s*(you|u)\b|\b(are|r)\s*(you|u)\b[^?.!]{0,40}\b(a\.?i\.?|bot|robot|human|real|person|machine|computer|chatgpt|gpt|program)\b|\bam i (talking|speaking) to\b/i;
const IDENTITY_MARKER = "I'm an AI chatbot";
const IDENTITY_REPLY =
  "I'm an AI chatbot, here to guide you through this writing exercise. Let's carry on \u2014 take your time and keep writing about this part of your future.";
const MAX_IDENTITY_ANSWERS = 2;

// The standardized close to every writing phase. Deliberately close-ended, with
// a second door: "add something" or "say more about something you mentioned".
const CLOSING_QUESTION =
  "Before we move on, is there anything you'd like to add, or any part you mentioned that you'd like to share more about?";
const CLOSING_Q_MARKER = "anything you'd like to add, or any part you mentioned";
const AFFIRM_CUES =
  /^(yes|yeah|yea|yep|yup|sure|ok|okay|i do|there is|there's|maybe|a bit|kind of|kinda)\b/i;
const AFFIRM_REPLY = "Of course — go ahead, take your time.";

// Standardized questions the bot asks that are NOT writing prompts. A reply to
// one of these ("not really", "no thanks") is a normal answer, not nonsense, so
// the off-task classifier must not see it. Probe rounds and phase prompts are
// deliberately absent: nonsense does arrive in answer to those.
const NON_WRITING_QUESTIONS = [
  CLOSING_Q_MARKER,
  "another part of your future you'd like to add to",
  "take your time and try to add onto what you've written",
];

// True when the bot's last message was this phase's closing question, so the
// participant's reply is a yes/no answer to it rather than more writing.
function answeringClosingQuestion(messages) {
  const lastBot = [...messages].reverse().find((m) => m.role === "assistant");
  return Boolean(lastBot) && String(lastBot.content).includes(CLOSING_Q_MARKER);
}

const CLOSING_ANSWER_NOTICE =
  "CLOSING ANSWER NOTICE: The participant is answering the closing question for this phase, so this reply is a yes or a no, not more writing. Ignore any word target — it does not apply here. Read their answer however they have phrased it: \"yes\", \"sure\", \"there is one thing\" mean yes; \"no\", \"not really\", \"nah I'm good\", \"can't think of anything\", \"nope that's it\", \"all good\" mean no. If it means yes, reply with one short warm line inviting them to write it, and nothing else. If it means no, do not comment on their answer and do not ask anything further — move straight on and open the next phase, giving its standardized block in full. If they have written their addition instead of answering, treat it as the addition.";

function answeringStandardQuestion(messages) {
  const lastBot = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastBot) return false;
  return NON_WRITING_QUESTIONS.some((q) => String(lastBot.content).includes(q));
}

function isAffirmative(text) {
  const s = String(text).trim();
  return Boolean(s) && countWords(s) <= 5 && AFFIRM_CUES.test(s);
}

// Explicit risk disclosures. Deliberately narrow, and it only ever adds a
// notice for the model — the model's own judgement still applies to everything
// this misses. Nothing here counts as writing.
const DISTRESS_CUES =
  /\b(kill|kills|killed|killing|murder\w*|stab\w*|shoot|shot|shooting|strangl\w*|poison\w*|hurt|hurting|harm|harming|attack\w*|beat up|burn\w*)\s+(my |the |a |an |his |her |their |our )?(self|myself|my ?self|himself|herself|themselves|them|him|her|someone|somebody|anyone|people|everyone|life|lives|dog|cat|pet|pets|animal\w*|family|mother|father|mum|mom|dad|parent\w*|brother|sister|sibling\w*|wife|husband|partner|girlfriend|boyfriend|child|children|kid|kids|baby|friend|friends|neighbou?r\w*|classmate\w*|colleague\w*|boss|teacher|roommate)\b|\bsuicid|\bend it all\b|\bdon'?t want to (live|be here|exist|wake up)\b|\bno (reason|point) (to|in) (living|live|going on|go on)\b|\bdon'?t see the point\b|\bself[- ]?harm|\bcutting myself\b|\bbetter off (dead|without me)\b|\btake (my|his|her|their) (own )?li(fe|ves)\b|\bwant to (die|disappear)\b|\bwish i (was|were) dead\b|\bhurt (someone|somebody|people|anyone)\b/i;

function isDistress(text) {
  return DISTRESS_CUES.test(String(text));
}

// Once distress has been raised the session stays in that mode until the
// participant says whether they want to stop or carry on.
const DISTRESS_MARKER = "1767";
const DISTRESS_END_MARKER = "approach the experimenter to let them know";
const DISTRESS_END_REPLY =
  "Thank you for telling me. Nothing you have written here is saved or recorded. Please approach the experimenter to let them know you would like to end the exercise.";
const STOP_CUES =
  /\b(stop|end it|end here|end the|quit|exit|leave|no more|i'?m done|im done|rather not continue|don'?t want to continue)\b/i;
const CONTINUE_CUES =
  /\b(continue|keep going|carry on|go on|keep writing|resume|i'?m ok|im ok|i'?m fine|im fine|i'?m alright|im alright)\b/i;

const DISTRESS_NOTICE =
  "DISTRESS NOTICE: The participant has said something that may indicate real distress or risk of harm. This overrides every other instruction you have been given, including any TIME NOTICE, DEPTH NOTICE or phase schedule. Stop the exercise immediately. Do not ask any follow-up questions about their future, do not use bullet points, do not open or continue any phase, and do not mention the timer or the end code. Reply in plain warm prose with three things and nothing else: first, one or two sentences of genuine, specific concern for what they have just said, without diagnosing, interpreting, or reassuring them that it will be fine; second, let them know support is available and give these resources exactly \u2014 Samaritans of Singapore (SOS) on their 24-hour hotline 1767, or CareText via WhatsApp on 9151 1767, and if they are an SMU student, Mrs Wong Kwok Leong Student Wellness Centre on campus; third, ask them plainly whether they would like to end the exercise here or whether they would prefer to continue. Ask nothing else.";

function isIdentityQuestion(text) {
  return IDENTITY_CUES.test(String(text));
}

// Anything phrased as a question to the guide should reach the model, which has
// the on-task redirect rule, rather than the nonsense re-ask.
function looksLikeQuestion(text) {
  const s = String(text).trim();
  return (
    s.includes("?") ||
    /^(what|why|how|who|when|where|can|could|do|does|did|is|are|will|should|am)('?s|s)?\b/i.test(s)
  );
}
const REDIRECT_REPLY =
  "Of course — we can leave that. Is there another part of your future you'd like to add to instead?";

function isRefusal(text) {
  return REFUSAL_CUES.test(String(text));
}

// Appended to notices on paths that sit far from the main prompt rules, where
// praise and recaps otherwise creep back in.
const RECAP_BAN =
  "Do not summarise or repeat back what they just wrote, and do not open with a recap. Do not praise, compliment, or characterise it — no \"that's great\", no \"lovely\", no telling them what their future sounds like. Open with a plain line such as \"Let's stay with this a little longer.\" and go straight to the questions, naming their own specifics inside the questions themselves.";

// The example opening lines offered to a stuck participant, per phase.
const PHASE_STUCK_HELP = {
  "Phase 2: Your Professional Life":
    '"I am a…" or "I have achieved…"',
  "Phase 3: Your Social Life":
    '"My relationships with __ are…" or "The people in my life who are most important to me are…"',
  "Phase 4: Your Leisure and Interests":
    '"When I have free time to myself, I…" or "I enjoy…"',
  "Phase 5: Your Personal Well-being":
    '"I\'ve become someone who is…" or "I feel…"',
};

function isStuck(text) {
  const s = String(text).trim();
  return Boolean(s) && countWords(s) <= 8 && STUCK_CUES.test(s);
}

// Two wordings so a participant who says "idk" repeatedly is not read the same
// sentence back each time.
function stuckReply(header, seen) {
  const examples = PHASE_STUCK_HELP[header];
  if (seen >= 2) {
    return `${STUCK_MARKERS[1]}. How about starting with something like, ${examples}`;
  }
  return `That's okay — ${STUCK_MARKERS[0]}. Take your time, and whenever you're ready you could begin with something like, ${examples}`;
}

// Served whole when a participant reached the end having written nothing: no
// narrative to fabricate, and no code to issue.
const NO_CODE_MARKER = "approach the experimenter";
const NO_WRITING_REPLY = `**Phase 6: Conclusion**

Our time is up for today. Because no writing was recorded during this session, an ending code cannot be issued. Please approach the experimenter for help.`;

// Each phase's starter line. The model trims these under time pressure, so a
// reply that opens a phase without its starter is rejected and re-run.
const PHASE_STARTERS = {
  "Phase 2: Your Professional Life": "I am a",
  "Phase 3: Your Social Life": "My relationships with",
  "Phase 4: Your Leisure and Interests": "When I have free time",
  "Phase 5: Your Personal Well-being": "I've become someone who is",
};

// The opening sentence each phase block must begin with, immediately after its
// header. Guards against paraphrasing, and against the carry-over sentence
// being placed after the header instead of before it.
const PHASE_OPENERS = {
  "Phase 2: Your Professional Life":
    "Let's start by imagining what this part of your ideal future looks like",
  "Phase 3: Your Social Life":
    "Now, think about what your relationships with important people",
  "Phase 4: Your Leisure and Interests":
    "Now, let's take a moment to think about how you spend your free time",
  "Phase 5: Your Personal Well-being":
    "Let's turn to you — your physical and mental well-being",
};

// What each phase is actually about, used to check that a carry-over sentence
// genuinely belongs to the phase it precedes.
const PHASE_SUBJECTS = {
  "Phase 2: Your Professional Life":
    "their work, career, education or vocation",
  "Phase 3: Your Social Life":
    "their relationships with other people — family, friends, partner or community",
  "Phase 4: Your Leisure and Interests":
    "their free time, hobbies, leisure and interests outside work and relationships",
  "Phase 5: Your Personal Well-being":
    "their physical and mental well-being, and the personal qualities they have developed",
};

// Fixed nudge openers for a participant who has gone quiet.
const NUDGE_OPENERS = [
  "Hey there — if you're having trouble writing, here are some more guiding questions you can consider, in addition to the ones I mentioned earlier:",
  "Still here whenever you are. Even a sentence or two is a fine place to start — here are a couple more questions you might consider:",
];

// Once the participant has declined twice there is nothing left to generate, so
// this is served straight from the server. The model was asked to hold and
// sometimes started asking questions again anyway; a fixed line cannot drift.
const HOLD_REPLY =
  "Thank you for what you've written. You can sit with what you have written for now, and I'll close things off shortly.";
const DECLINE_WORDS = 15; // a reply shorter than this counts as "nothing more"

// A short reply carrying a closure cue means the participant is done with this
// phase. That is respected even if the word target has not been met — probing
// someone who has just said they have nothing more is what produced loops.
const DECLINE_CUES =
  /\b(no|nope|nah|none|nothing|done|finished|that'?s it|that'?s all|thats it|thats all|that'?s everything|thats everything)\b/i;

function isDecline(text) {
  const t = String(text).trim();
  return Boolean(t) && countWords(t) <= 8 && DECLINE_CUES.test(t);
}

// Returned without calling OpenAI when the start code has not been matched.
const BAD_CODE_LINE =
  "That code isn't recognised. Please check the Qualtrics page and enter the start code exactly as it appears there, including capital letters.";

const DOMAIN_HEADERS = [
  "Phase 2: Your Professional Life",
  "Phase 3: Your Social Life",
  "Phase 4: Your Leisure and Interests",
  "Phase 5: Your Personal Well-being",
];

// Sent after the session has concluded, without calling OpenAI at all.
const CLOSING_LINE =
  "This session has concluded. Thank you again for taking part.";

// True when a reply buries a question under a new phase header — i.e. it asked
// the participant something and then moved on without letting them answer.
// Plain declarative text before a header is allowed: that is how the bot refers
// back to material they mentioned in an earlier phase.
function mergesIntoNextDomain(text) {
  const body = String(text);
  const header = DOMAIN_HEADERS.find((h) => body.includes(`**${h}**`));
  if (!header) return false;

  const before = body.slice(0, body.indexOf(`**${header}**`));
  const hasQuestion = before.includes("?");
  const hasBulletLine = before
    .split("\n")
    .some((line) => line.trimStart().startsWith("- "));
  return hasQuestion || hasBulletLine;
}

// A phase block whose header is not immediately followed by its exact opening
// sentence: either paraphrased, or something was inserted after the header.
function malformedPhaseBlock(text) {
  const body = String(text);
  const header = Object.keys(PHASE_OPENERS).find((h) =>
    body.includes(`**${h}**`)
  );
  if (!header) return null;
  const after = body
    .slice(body.indexOf(`**${header}**`) + header.length + 4)
    .trimStart();
  return after.startsWith(PHASE_OPENERS[header]) ? null : header;
}

// A reply that opens a phase but drops that phase's starter line.
function missingStarter(text) {
  const body = String(text);
  const header = Object.keys(PHASE_STARTERS).find((h) =>
    body.includes(`**${h}**`)
  );
  return header && !body.includes(PHASE_STARTERS[header]) ? header : null;
}

// How many nudges have already gone out in the current phase.
function nudgeIndex(messages) {
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "assistant" && DOMAIN_HEADERS.some((h) => String(m.content).includes(h))) {
      start = i;
    }
  });
  return messages
    .slice(start)
    .filter(
      (m) =>
        m.role === "assistant" &&
        NUDGE_OPENERS.some((o) => String(m.content).includes(o.slice(0, 40)))
    ).length;
}

// "complete" = wrote something in all four phases. "partial" = wrote something,
// but not everywhere. "none" = nothing at all. Off-task replies and bare
// declines do not count as writing.
function completionState(messages) {
  const counts = {};
  let current = null;
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      const h = DOMAIN_HEADERS.find((x) => String(m.content).includes(x));
      if (h) current = h;
      return;
    }
    if (m.role !== "user" || !current) return;
    const next = messages[i + 1];
    const offTask =
      next &&
      next.role === "assistant" &&
      String(next.content).includes(OFF_TASK_MARKER);
    const stuck =
      next && next.role === "assistant" && isStuckReply(next.content);
    const refusedHere =
      next &&
      next.role === "assistant" &&
      String(next.content).includes(PHASE_REFUSAL_ACK);
    const identity =
      next &&
      next.role === "assistant" &&
      String(next.content).includes(IDENTITY_MARKER);
    if (offTask || stuck || refusedHere || identity || isDecline(m.content))
      return;
    counts[current] = (counts[current] || 0) + countWords(m.content);
  });

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return "none";
  return DOMAIN_HEADERS.every((h) => (counts[h] || 0) > 0)
    ? "complete"
    : "partial";
}

function countWords(text) {
  const t = String(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

// Counts follow-up probe rounds. Deliberately matches only "- " lines: the
// standardized blocks use "* " bullets and must not be counted as probes.
function hasBullets(text) {
  return String(text)
    .split("\n")
    .some((line) => line.trimStart().startsWith("- "));
}

// Word counts and probe rounds for whichever phase is currently open.
function phaseStats(messages) {
  let start = -1;
  let header = null;
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const found = DOMAIN_HEADERS.find((h) => String(m.content).includes(h));
    if (found) {
      start = i;
      header = found;
    }
  });

  if (start === -1) return null; // introduction, not in a phase yet

  const since = messages.slice(start + 1);

  // A user turn answered with the fixed off-task re-ask does not count toward
  // this phase: not its words, and not as an attempt.
  const userTurns = [];
  let offTaskCount = 0;
  let stuckCount = 0;
  let identityCount = 0;
  let refused = false;
  since.forEach((m, i) => {
    if (m.role !== "user") return;
    const next = since[i + 1];
    const answered = next && next.role === "assistant" ? String(next.content) : "";
    if (answered.includes(OFF_TASK_MARKER)) offTaskCount += 1;
    else if (isStuckReply(answered)) stuckCount += 1;
    else if (answered.includes(PHASE_REFUSAL_ACK)) refused = true;
    else if (answered.includes(IDENTITY_MARKER)) identityCount += 1;
    else userTurns.push(m);
  });

  if (userTurns.length === 0) {
    return offTaskCount || stuckCount || identityCount || refused
      ? { header, offTaskCount, stuckCount, identityCount, refused, complete: refused, empty: true }
      : null;
  }

  const totalWords = userTurns.reduce((n, m) => n + countWords(m.content), 0);
  const rounds = since.filter(
    (m) => m.role === "assistant" && hasBullets(m.content)
  ).length;
  // Any decline in this phase counts, not just the most recent turn — a later
  // "ok" must not undo the fact that they already said they were finished.
  const declined = userTurns.some((m) => isDecline(m.content));
  const closingAsked = since.some(
    (m) => m.role === "assistant" && String(m.content).includes(CLOSING_Q_MARKER)
  );

  return {
    header,
    offTaskCount,
    stuckCount,
    identityCount,
    refused,
    closingAsked,
    userTurns,
    totalWords,
    firstTurnWords: countWords(userTurns[0].content),
    rounds,
    // Phase is finished on any of: word target met, probed out, or the
    // participant saying they have nothing more once there is something there.
    complete:
      refused ||
      totalWords >= WORD_TARGET ||
      rounds >= MAX_PROBE_ROUNDS ||
      (declined && (rounds >= 1 || totalWords >= NOTHING_TO_REFLECT)),
    declined,
  };
}

// True once the last phase has met its depth criteria, i.e. the writing phases
// are finished and any remaining time is spare.
function inExtraTime(messages) {
  // Once the spare-time sequence has begun it never reverts to phase probing,
  // whatever the participant types next.
  const said = messages
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content))
    .join("\n");
  if (
    said.includes(INTERIM_MARKER) ||
    said.includes(DAYLIFE_MARKER) ||
    said.includes(HOLD_MARKER)
  ) {
    return true;
  }

  const stats = phaseStats(messages);
  if (!stats) return false;
  if (stats.header !== DOMAIN_HEADERS[DOMAIN_HEADERS.length - 1]) return false;
  return Boolean(stats.complete);
}

// True once the participant has declined both the draft and the day walkthrough,
// or has already been put on hold.
function inHoldState(messages) {
  const said = messages
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content))
    .join("\n");
  if (said.includes(HOLD_MARKER)) return true;

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUser ? String(lastUser.content) : "";
  const declined = isDecline(lastText) || countWords(lastText) < 4;
  return said.includes(INTERIM_MARKER) && said.includes(DAYLIFE_MARKER) && declined;
}

// Spare time after all four phases are done. Runs a fixed sequence so the model
// always has a fresh task and can never fall back into re-probing one phase.
function extraTimeNotice(messages) {
  const said = messages
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content))
    .join("\n");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUser ? String(lastUser.content) : "";
  // Cue-based, not length-based: "I also volunteer on Sundays" is eight words
  // of real material and must not be read as "nothing more".
  const declined = isDecline(lastText) || countWords(lastText) < 4;

  const interimDone = said.includes(INTERIM_MARKER);
  const dayLifeDone = said.includes(DAYLIFE_MARKER);

  // Once the hold has been issued it is permanent. Someone who has declined
  // twice does not get asked again just because they typed "ok".
  if (said.includes(HOLD_MARKER)) {
    return `EXTRA TIME NOTICE: This participant has finished contributing and is waiting for the session to end. Ask nothing. Reply with one short warm sentence and nothing else, whatever they write. Do not ask questions, do not repeat earlier questions, do not conclude, and do not reveal the end code.`;
  }

  if (!interimDone) {
    return `EXTRA TIME NOTICE: All four writing phases are finished and time remains. Do not conclude and do not reveal the end code. Send exactly one message made of these four parts, in this order, with a blank line between each and nothing else added:

(1) A short interim narrative of their future in flowing prose, with no header and no bullets, built only from what they themselves wrote across the four phases. Every rule that governs the Phase 6 synthesis governs this one: invent no detail they did not give, append no meaning to their details, use no descriptive word they did not write themselves, and make no evaluation of them or of their writing.

(2) This line, word for word: "${INTERIM_INVITE}"

(3) At most three follow-up questions, each on its own line beginning with a hyphen and a space, fitted to what they actually wrote and never repeating a question already asked.

(4) This line, word for word: "${INTERIM_FOOTER}"

Never ask whether the narrative is accurate, never ask them to check, correct or fix it, and never offer to change it.`;
  }

  if (!dayLifeDone && declined) {
    return `EXTRA TIME NOTICE: They had nothing to add to the draft, and time still remains. Do not conclude and do not repeat any question you have already asked. Ask them instead, warmly and in one or two sentences of plain prose with no bullets and no header, to walk you through "${DAYLIFE_MARKER}" in this future life, from waking up to going to sleep, in the order it happens.`;
  }

  if (!dayLifeDone) {
    return `EXTRA TIME NOTICE: They have added new material and time remains. Ask one round of two or three questions, each on its own line beginning with a hyphen and a space. Ask about a DIFFERENT area of their future from the one your last round covered — rotate between their professional life, their social life, their leisure and interests, and their well-being rather than staying on one topic. Never spend two rounds in a row on the same subject, and never press a subject they have asked to leave. Do not conclude.${RECAP_BAN}`;
  }

  if (declined) {
    return `EXTRA TIME NOTICE: They have now declined twice and time still remains on the clock. Stop asking questions altogether. Reply with exactly one short warm sentence that contains the phrase "${HOLD_MARKER}" — for example "You can ${HOLD_MARKER}, and I'll close things off shortly." — and write nothing else. Ask nothing, repeat nothing, do not conclude, and do not reveal the end code. If they write again, reply the same way.`;
  }

  return `EXTRA TIME NOTICE: They are still writing and time remains. Ask one round of two or three questions, each on its own line beginning with a hyphen and a space. Ask about a DIFFERENT area of their future from the one your last round covered — rotate between their professional life, their social life, their leisure and interests, and their well-being rather than staying on one topic. Never spend two rounds in a row on the same subject, and never press a subject they have asked to leave. Do not conclude.${RECAP_BAN}`;
}

function depthNotice(messages) {
  const stats = phaseStats(messages);
  if (!stats || stats.empty) return null;

  const {
    header,
    userTurns,
    totalWords,
    firstTurnWords,
    rounds,
    declined,
    closingAsked,
  } = stats;
  const closeStep = closingAsked
    ? "You have already asked the closing question in this phase, so do not ask it again. Move straight on to the next phase."
    : `Ask the closing question for this phase, worded exactly: "${CLOSING_QUESTION}" Write nothing else in that message.`;
  const firstReplyThin = firstTurnWords < WORD_TARGET;
  const reminder = ` Format this reply exactly as follows: the plain introductory line, then the questions each on their own line beginning with a hyphen and a space, then a blank line, then this sentence on its own line, word for word: "${DETAIL_REMINDER}" Do not drop the hyphens and do not drop the introductory line.`;

  const facts = `DEPTH NOTICE: In "${header}", the participant has written ${totalWords} words across ${userTurns.length} repl${
    userTurns.length === 1 ? "y" : "ies"
  }, their first reply here was ${firstTurnWords} words, and you have asked ${rounds} round(s) of follow-up questions in this domain.`;

  if (rounds === 0) {
    if (firstTurnWords < SHORT_FIRST_TURN) {
      return `${facts} That opening reply is short. Ask exactly three questions, and make the first one a scene question that walks them through a concrete moment in time — what a normal day looks like from morning to night, or a single moment pictured in detail. Abstract questions will not draw more out of them; a concrete scene will.${reminder}`;
    }
    if (firstTurnWords > WORD_TARGET) {
      return `${facts} They have already given breadth here, so do not ask them to cover more ground. Ask exactly two questions, both drilling further into one single concrete detail they named — choose the most specific image in what they wrote and have them zoom into it.`;
    }
    return `${facts} Ask exactly three questions. At least one must name something concrete the participant actually wrote — a place, person, object or action from their own reply — inside the question itself, so it could not have been asked of anyone else. Draw the rest from the bank.${reminder}`;
  }

  if (rounds >= MAX_PROBE_ROUNDS && totalWords < NOTHING_TO_REFLECT) {
    return `${facts} You have probed this phase enough and they have given you essentially nothing to work with. Do not summarise, do not remark on how little they wrote, and do not mention that they were unsure or could not picture it. Write one short, easy, unbothered sentence moving things along, then open the next phase. That next opening prompt must still be delivered in full and word for word, including its bold header, its bulleted questions, and its suggested opening lines.`;
  }

  if (rounds >= MAX_PROBE_ROUNDS) {
    return `${facts} You have probed this phase enough and they are not producing more. Ask no further questions here, and do not summarise what they wrote. ${closeStep}`;
  }

  if (declined && (rounds >= 1 || totalWords >= NOTHING_TO_REFLECT)) {
    return `${facts} They have just said they have nothing more to add here. Respect that — ask no further questions in this phase, even though the word target has not been met. Do not summarise what they wrote. Move straight on to the next phase.`;
  }

  if (totalWords < WORD_TARGET) {
    return `${facts} That is below the ${WORD_TARGET}-word target for a domain, so do not move on yet. Ask another round of two or three questions, drilling into what they have already named rather than opening new ground.`;
  }

  return `${facts} They have passed the ${WORD_TARGET}-word target for this phase. Do not summarise what they wrote. ${closeStep}`;
}

function scheduleLine(elapsedMin) {
  const overdue = DEADLINES.filter((d) => elapsedMin >= d.byMin).pop();
  const upcoming = DEADLINES.find((d) => elapsedMin < d.byMin);

  if (overdue) {
    return `You are behind schedule: by now you should have reached ${overdue.stage}. Do not skip any domain to catch up. Move to the next domain you have not yet covered and compress from here — one round of follow-ups per phase, one short sentence of reflection, and no closing question — until all four writing phases are covered.`;
  }
  return `Nothing is overdue. The next deadline is ${upcoming.stage}, which must be started by minute ${upcoming.byMin}.`;
}

function timeNotice(elapsedMs, extraTime) {
  const elapsedMin = elapsedMs / 60000;
  const shown = Math.floor(elapsedMin);

  if (elapsedMin >= HARD_LIMIT_MIN) {
    return "TIME NOTICE: Time is up. Stop the writing phase now, whatever domain you are on. Move straight to the Phase 6 conclusion using whatever the participant has already shared. Give the Phase 6 header, the extra 'Our time is up for today.' line, then the narrative, then the standardized closing message with the end code. Do not mention the timer to the participant.";
  }

  if (elapsedMin >= MIN_BEFORE_END_MIN) {
    return `TIME NOTICE: ${shown} minutes have elapsed. The writing phases are over. Move to the Phase 6 conclusion now — header, narrative synthesis, then the standardized closing message. Do not mention the timer to the participant.`;
  }

  // In spare time there is no schedule left to chase, and telling the model it
  // is "behind" would push it back into phase work it has already completed.
  if (extraTime) {
    return `TIME NOTICE: THE SESSION IS NOT OVER. Only ${shown} of the ${MIN_BEFORE_END_MIN} minutes have passed and there is still time left on the clock. The four writing phases are done, so there is no schedule to catch up on and no phase to reopen, but that is not the same as the session ending. Do not write the Phase 6 conclusion. Do not write "Our time is up for today." Do not reveal the end code. Follow the EXTRA TIME NOTICE exactly and keep the exercise going. Never mention the timer to the participant.`;
  }

  return `TIME NOTICE: ${shown} minutes have elapsed of a ${MIN_BEFORE_END_MIN} minute writing phase. ${scheduleLine(
    elapsedMin
  )} These are latest-start deadlines, not targets — if the participant has already given a domain enough concrete detail, move on ahead of schedule rather than padding it out. You may not deliver the synthesis or the ending code before minute ${MIN_BEFORE_END_MIN}; if all four domains are done before then, go back to the domain they said least about and probe there. Never mention the timer or the schedule to the participant.`;
}

// One narrow yes/no judgement, deliberately kept out of the main prompt so the
// session rules cannot pull it around. Fails open: a genuine answer wrongly
// rejected is far worse than a bad one let through.
async function isOnTask(phaseHeader, text) {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 3,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `A participant is doing a writing exercise about their imagined best possible future. The current section is "${phaseHeader}". Decide whether their reply is a genuine attempt at that task. Answer with one word: YES or NO.

Answer YES for any sincere attempt, however short, plain, modest, unusual, oddly phrased, or written in imperfect English. Unconventional or surprising futures are completely valid and must be accepted. Brief answers are valid.

Always answer YES if the reply expresses any feeling, worry, difficulty, or personal disclosure of any kind, however far it strays from the topic — those must always reach the guide.

Always answer YES if the reply mentions harm, violence, death, injury or danger to anyone at all — themselves, other people, children, or animals — however strange, alarming, or implausible it sounds, and even if it reads like a joke. Those must always reach the guide, without exception.

Answer NO only when the reply is unintelligible, invented or random words, or obvious nonsense with no meaning at all.

If you are at all unsure, answer YES.`,
        },
        { role: "user", content: String(text) },
      ],
    });
    return !/^\s*no\b/i.test(r.choices[0].message.content || "");
  } catch {
    return true;
  }
}

// A carry-over sentence is only allowed when it refers to material that
// genuinely belongs to the phase being opened. Otherwise it is just a recap.
async function carryOverFits(header, lead) {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 3,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `A writing guide is about to open a section about ${PHASE_SUBJECTS[header]}. Just before that section it wrote a sentence referring back to something the participant said earlier. Answer YES or NO: does that sentence refer to material that genuinely belongs to ${PHASE_SUBJECTS[header]}?

Answer NO if it merely summarises or recaps what the participant wrote about a different area, even if it is accurate. Being about the same people or setting is not enough — it must be about ${PHASE_SUBJECTS[header]} itself. For example, "you mentioned wanting to create fun lessons for primary school children" is about their work, not about their own relationships, so for a relationships section the answer is NO. Answer YES only if the material it names really is about ${PHASE_SUBJECTS[header]}. If unsure, answer NO.`,
        },
        { role: "user", content: String(lead) },
      ],
    });
    return !/^\s*no\b/i.test(res.choices[0].message.content || "");
  } catch {
    return true;
  }
}

async function ask(messages, notices, endCode) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    // Low, deliberately. Standardized blocks must arrive identically for every
    // participant, and rule-following is far steadier here than at the default
    // of 1.0. Follow-up questions still vary, because they are drawn from the
    // bank and fitted to what each participant actually wrote.
    temperature: 0.3,
    max_tokens: 1000,
    messages: [
      { role: "system", content: buildSystemPrompt(endCode) },
      ...messages,
      ...notices.map((content) => ({ role: "system", content })),
    ],
  });
  return completion.choices[0].message.content;
}

export async function POST(request) {
  try {
    const { messages, elapsedMs = 0, nudge = false } = await request.json();
    // Which code this session earns. The model is only ever shown one of them,
    // so there is nothing for it to confuse or leak.
    const state = completionState(messages);
    const endCode =
      state === "complete"
        ? process.env.END_CODE
        : process.env.INCOMPLETE_CODE || process.env.END_CODE;

    // Has the conclusion already gone out? Checked against the transcript
    // itself, so it can't be bypassed by the browser or talked around.
    const issued = [process.env.END_CODE, process.env.INCOMPLETE_CODE]
      .filter(Boolean)
      .concat(NO_CODE_MARKER, DISTRESS_END_MARKER);
    const alreadyConcluded = messages.some(
      (m) =>
        m.role === "assistant" &&
        issued.some((c) => String(m.content).includes(c))
    );

    if (alreadyConcluded) {
      // Ended after distress: never re-engage, and keep pointing them to the
      // experimenter rather than giving the ordinary closing line.
      const endedInDistress = messages.some(
        (m) =>
          m.role === "assistant" &&
          String(m.content).includes(DISTRESS_END_MARKER)
      );
      return Response.json({
        reply: endedInDistress ? DISTRESS_END_REPLY : CLOSING_LINE,
        concluded: true,
      });
    }

    // The start code is matched here, in code, so it is exact and case
    // sensitive. The model never gets to decide whether a code is close enough.
    const startCode = process.env.START_CODE;
    const codeValid =
      Boolean(startCode) &&
      messages.some(
        (m) => m.role === "user" && String(m.content).trim() === startCode.trim()
      );

    if (!codeValid) {
      return Response.json({ reply: BAD_CODE_LINE, started: false });
    }

    // The clock starts when the participant types Start after the introduction
    // — not at code entry, and not on page load.
    const introIndex = messages.findIndex(
      (m) => m.role === "assistant" && String(m.content).includes(INTRO_HEADER)
    );
    const startIndex =
      introIndex === -1
        ? -1
        : messages.findIndex(
            (m, i) =>
              i > introIndex &&
              m.role === "user" &&
              String(m.content).trim().toLowerCase().replace(/[.!?"']/g, "") ===
                START_WORD
          );
    const started = startIndex !== -1;

    const startNotice =
      introIndex !== -1 && !started
        ? "START NOTICE: The participant has not typed Start yet, so the exercise has not begun and the clock is not running. Do not open Phase 2 and do not treat their message as an answer to anything. Reply with one warm sentence asking them to type Start when they are ready, and nothing else."
        : null;

    // Once the writing phase is over, depth no longer applies — suppress the
    // notice entirely rather than leaving the model to arbitrate a conflict.
    const writingPhaseOver = elapsedMs >= MIN_BEFORE_END_MIN * 60000;
    // Reached the end having written nothing: there is no narrative to build
    // and no code to give, so this is served whole rather than generated.
    if (writingPhaseOver && state === "none") {
      return Response.json({ reply: NO_WRITING_REPLY, concluded: true });
    }

    const extraTime = !writingPhaseOver && inExtraTime(messages);

    // Idle nudge: the participant has gone quiet, so offer a couple more
    // guiding questions. Skipped once they have said they are finished.
    if (nudge) {
      if (writingPhaseOver || extraTime) {
        return Response.json({ skip: true });
      }
      const opener = NUDGE_OPENERS[Math.min(nudgeIndex(messages), 1)];
      const reply = await ask(messages, [
        `NUDGE NOTICE: The participant has gone quiet and has not written anything for a while. Do not treat this as an answer and do not move the exercise on. Reply with exactly two parts and nothing else: first this line word for word — "${opener}" — then exactly two guiding questions for the phase they are currently in, each on its own line beginning with a hyphen and a space. Draw them from the question bank and fit them to whatever they have written so far. Before you send, read back through every question already in this conversation, including any in an earlier nudge, and pick two that do not appear anywhere in it — repeating a question you have already put to them is not acceptable. Add no header, no reflection, no other sentence, and never remark on their silence.`,
      ], endCode);
      return Response.json({ reply, started: true, concluded: false });
    }

    const stats = phaseStats(messages);
    const last = messages[messages.length - 1];

    // Distress overrides everything: no classifier, no depth targets, no
    // schedule, no phase machinery.
    if (last && last.role === "user" && isDistress(last.content)) {
      const reply = await ask(messages, [DISTRESS_NOTICE], endCode);
      return Response.json({ reply, started: true, concluded: false });
    }

    // Already in distress mode: nothing resumes until they answer the
    // stop-or-continue question.
    const raised = messages.some(
      (m) => m.role === "assistant" && String(m.content).includes(DISTRESS_MARKER)
    );
    if (raised && last && last.role === "user") {
      if (CONTINUE_CUES.test(last.content)) {
        // fall through to the normal flow and pick the exercise back up
      } else if (STOP_CUES.test(last.content)) {
        return Response.json({ reply: DISTRESS_END_REPLY, concluded: true });
      } else {
        const reply = await ask(
          messages,
          [
            `DISTRESS NOTICE: You have already offered support and asked whether they want to stop or continue, and they have not clearly said which. Do not resume the exercise, do not ask about their future, and do not use bullet points. Reply in one or two warm sentences that gently repeat the choice: they can end the exercise here, or carry on if they would like to.`,
          ],
          endCode
        );
        return Response.json({ reply, started: true, concluded: false });
      }
    }

    // "Yes" to the closing question: invite them to write, rather than treating
    // a one-word answer as content or as nonsense.
    if (
      stats &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      isAffirmative(last.content) &&
      messages.some(
        (m) =>
          m.role === "assistant" && String(m.content).includes(CLOSING_Q_MARKER)
      )
    ) {
      return Response.json({
        reply: AFFIRM_REPLY,
        started: true,
        concluded: false,
      });
    }

    // Asked what I am. Answered honestly, identically every time, then back to
    // the exercise.
    if (
      stats &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      isIdentityQuestion(last.content) &&
      (stats.identityCount || 0) < MAX_IDENTITY_ANSWERS
    ) {
      return Response.json({
        reply: IDENTITY_REPLY,
        started: true,
        concluded: false,
      });
    }

    // Refusing a whole writing phase: acknowledge once and move on. The phase
    // is left unwritten, which is what earns the incomplete end code.
    if (
      stats &&
      !extraTime &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      isRefusal(last.content)
    ) {
      const i = DOMAIN_HEADERS.indexOf(stats.header);
      const next = DOMAIN_HEADERS[i + 1];
      const instruction = next
        ? `Then open "${next}" — its bold header, then its standardized block in full and word for word, including both bulleted questions and the sentence beginning "If you're". Write nothing else at all.`
        : "Write nothing else at all — no questions, no header, no comment.";
      const reply = await ask(
        messages,
        [
          `REFUSAL NOTICE: The participant has asked not to write about this area. Accept that immediately and completely. Do not ask them to reconsider, do not ask why, do not ask a smaller version of the same question, and never raise this area again for the rest of the session. Begin your reply with exactly this sentence: "${PHASE_REFUSAL_ACK}" ${instruction}`,
        ],
        endCode
      );
      return Response.json({ reply, started: true, concluded: false });
    }

    // Stuck, not off-task: reassure and offer this phase's starter line. Served
    // from code, and checked before the classifier so it never reads as "I
    // didn't understand you".
    if (
      stats &&
      !extraTime &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      isStuck(last.content) &&
      !answeringClosingQuestion(messages.slice(0, -1)) &&
      (stats.stuckCount || 0) < MAX_STUCK_HELPS &&
      PHASE_STUCK_HELP[stats.header]
    ) {
      return Response.json({
        reply: stuckReply(stats.header, stats.stuckCount || 0),
        started: true,
        concluded: false,
      });
    }

    // Off-task check on the newest reply, capped so nobody gets trapped in a
    // loop of being asked again. Declines are skipped — "no, that's everything"
    // is a legitimate answer, not an attempt at the task.
    if (
      stats &&
      !extraTime &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      !isDecline(last.content) &&
      !isStuck(last.content) &&
      !looksLikeQuestion(last.content) &&
      !answeringStandardQuestion(messages.slice(0, -1)) &&
      (stats.offTaskCount || 0) < MAX_OFF_TASK_REASKS &&
      !(await isOnTask(stats.header, last.content))
    ) {
      return Response.json({
        reply: OFF_TASK_REPLY,
        started: true,
        concluded: false,
      });
    }

    // Topic refusal during spare time. First one redirects and hands them the
    // choice; a second means they are finished, so questioning stops.
    if (extraTime && last && last.role === "user" && isRefusal(last.content)) {
      const refusals = messages.filter(
        (m) => m.role === "assistant" && String(m.content).includes(REDIRECT_MARKER)
      ).length;
      return Response.json({
        reply: refusals >= 1 ? HOLD_REPLY : REDIRECT_REPLY,
        started: true,
        concluded: false,
      });
    }

    // Nothing left to ask and the clock has not run out: hold, without spending
    // a model call on it.
    if (extraTime && inHoldState(messages)) {
      return Response.json({ reply: HOLD_REPLY, started: true, concluded: false });
    }

    const closingAnswer =
      !extraTime &&
      !writingPhaseOver &&
      last &&
      last.role === "user" &&
      answeringClosingQuestion(messages.slice(0, -1));

    const notices = [
      startNotice ?? timeNotice(elapsedMs, extraTime),
      startNotice || writingPhaseOver
        ? null
        : closingAnswer
        ? CLOSING_ANSWER_NOTICE
        : extraTime
        ? extraTimeNotice(messages)
        : depthNotice(messages),
    ].filter(Boolean);
    let reply = await ask(messages, notices, endCode);

    // Floor on session length: if the model tries to hand out the ending code
    // early, reject that reply and make it keep going.
    // Premature ending, whether or not it carried the code: the "time is up"
    // line and the Phase 6 header both count as concluding.
    const tooEarly =
      elapsedMs < MIN_BEFORE_END_MIN * 60000 &&
      ((Boolean(endCode) && reply.includes(endCode)) ||
        reply.includes("Phase 6: Conclusion") ||
        reply.includes("Our time is up for today"));

    if (tooEarly) {
      reply = await ask(messages, [
        ...notices,
        `TIME NOTICE: You were about to end the session too early. Only ${Math.floor(
          elapsedMs / 60000
        )} minutes have elapsed and the exercise may not conclude before minute ${MIN_BEFORE_END_MIN}. Do not write the Phase 6 conclusion, do not write "Our time is up for today.", and do not reveal the end code. The session is still running. Continue the exercise instead: stay with whatever the participant wrote most recently and ask one round of two or three follow-up questions about it, each on its own line beginning with a hyphen and a space.`,
      ], endCode);
    }

    const malformed = malformedPhaseBlock(reply);
    if (malformed) {
      reply = await ask(
        messages,
        [
          ...notices,
          `FORMAT NOTICE: Your previous attempt opened "${malformed}" incorrectly. That phase's bold header must be followed immediately by its opening sentence, word for word, with nothing in between and nothing paraphrased. If you are referring back to something they mentioned in an earlier phase, that sentence goes BEFORE the header, never after it. Send the message again: optional carry-over sentence first, then the header, then the standardized block in full and unaltered.`,
        ],
        endCode
      );
    }

    // Standardized blocks must arrive whole, including the starter line, which
    // the model otherwise trims when it is behind schedule.
    const dropped = missingStarter(reply);
    if (dropped) {
      reply = await ask(messages, [
        ...notices,
        `FORMAT NOTICE: Your previous attempt opened "${dropped}" but left out its standardized starter line. Send that phase's opening block again in full, word for word, including its bold header, both bulleted questions, and the sentence beginning "If you're" that offers example opening lines. Standardized blocks are never shortened, no matter how far behind schedule you are.`,
      ], endCode);
    }

    // A reply that opens a new domain must open with that domain's header and
    // nothing before it, so a closing question never gets buried under it.
    if (mergesIntoNextDomain(reply)) {
      reply = await ask(messages, [
        ...notices,
        "FORMAT NOTICE: Your previous attempt asked the participant a question and then opened the next phase in the same message, so they never got to answer it. Send one or the other, never both. If this phase is finished, open the next one — you may put a short plain sentence before its header referring back to something they mentioned earlier, but no questions and no bullets there. If this phase is not finished, ask your question and end the message there.",
      ], endCode);
    }

    // Last thing before sending: a carry-over sentence that is really a recap of
    // the phase just finished gets cut. This runs after every retry above,
    // because those regenerate the reply and can reintroduce one.
    const openedHeader = Object.keys(PHASE_SUBJECTS).find((h) =>
      reply.includes(`**${h}**`)
    );
    if (openedHeader) {
      const at = reply.indexOf(`**${openedHeader}**`);
      const lead = reply.slice(0, at).trim();
      if (lead && !(await carryOverFits(openedHeader, lead))) {
        reply = reply.slice(at);
      }
    }

    return Response.json({
      reply,
      started,
      concluded: Boolean(endCode) && reply.includes(endCode),
    });
  } catch (error) {
    console.error("OpenAI error:", error);
    return Response.json(
      { error: error.message || "Something went wrong." },
      { status: 500 }
    );
  }
}
