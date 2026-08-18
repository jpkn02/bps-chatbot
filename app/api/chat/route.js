import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Swap to "gpt-4o" here to test a stronger model.
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Depth targets. The model cannot count words reliably, so the server counts
// and tells it what to do.
const FOLLOW_UPS_PER_PHASE = 2; // the scene, then the felt experience

// One scene form and one felt form per phase, assigned by phase index so no
// form is ever used twice in a session. Four phases, four of each: they line up
// exactly. The model rewrites the chosen form around the participant's own
// material but must keep its shape.
const SCENE_FORMS = [
  "What'll a normal day look like? I'd love to hear more about that, from morning to night.",
  "Picture one particular moment in this future, what'll be happening?",
  "What does that moment look like to you? I'm curious about what comes to mind for you.",
  "I'm wondering now, how do you think this will unfold?",
];
const FELT_FORMS = [
  "As you imagine yourself there, what will it probably feel like?",
  "Could you tell me more about what would feel especially meaningful to you about this part of your future?",
  "What do you think you'd enjoy most about having this be part of your life? I'd love to get a better sense of that.",
  "I'd like to know more — when that happens, how do you think you will feel?",
];

// Must match the domain headers in system-prompt.txt.
// The clock starts when the participant types Start after this block.
const INTRO_HEADER = "Phase 1: Introduction";
const START_WORD = "start";

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

// "complete" = wrote something in all four phases. "partial" = wrote something,
// but not everywhere. "none" = nothing at all. Off-task replies, stuck replies,
// refusals and bare declines do not count as writing.
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
    const answered =
      next && next.role === "assistant" ? String(next.content) : "";
    if (
      answered.includes(OFF_TASK_MARKER) ||
      isStuckReply(answered) ||
      answered.includes(PHASE_REFUSAL_ACK) ||
      answered.includes(IDENTITY_MARKER) ||
      isDecline(m.content)
    ) {
      return;
    }
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

// Follow-ups are plain prose now, so they are counted by exclusion: any bot
// message in this phase that is not a standardized block and not one of the
// fixed canned replies is a follow-up.
function isCannedReply(text) {
  const s = String(text);
  return (
    s.includes(OFF_TASK_MARKER) ||
    isStuckReply(s) ||
    s.includes(PHASE_REFUSAL_ACK) ||
    s.includes(IDENTITY_MARKER) ||
    s.includes(DISTRESS_MARKER)
  );
}

function isFollowUp(text) {
  const s = String(text);
  if (isCannedReply(s)) return false;
  return !DOMAIN_HEADERS.some((h) => s.includes(h)) && !s.includes("Phase 6");
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
    (m) => m.role === "assistant" && isFollowUp(m.content)
  ).length;
  // Any decline in this phase counts, not just the most recent turn — a later
  // "ok" must not undo the fact that they already said they were finished.
  const declined = userTurns.some((m) => isDecline(m.content));

  return {
    header,
    offTaskCount,
    stuckCount,
    identityCount,
    refused,
    userTurns,
    totalWords,
    firstTurnWords: countWords(userTurns[0].content),
    rounds,
    // Phase is finished on any of: word target met, probed out, or the
    // participant saying they have nothing more once there is something there.
    complete: refused || rounds >= FOLLOW_UPS_PER_PHASE || declined,
    declined,
  };
}

function depthNotice(messages) {
  const stats = phaseStats(messages);
  if (!stats || stats.empty) return null;

  const { header, rounds, declined, refused } = stats;
  const phaseIndex = DOMAIN_HEADERS.indexOf(header);
  const isLastPhase = phaseIndex === DOMAIN_HEADERS.length - 1;

  const onward = isLastPhase
    ? "This was the final writing phase, so the exercise is over. Deliver the Phase 6 conclusion now: its bold header, the standardized line inviting them to read it, the narrative built from everything they wrote across all four phases, then the standardized closing message with the end code."
    : "Move straight on and open the next phase, giving its standardized block in full.";

  const style =
    " Take the form above and rewrite it around what this participant actually wrote, keeping its shape and its wording as close as you can while swapping in their own specifics. Do not merge in other questions, do not bolt extra questions onto it, and do not invent a different question. Ask one question only, in plain prose, with no bullet points and no introductory line before it. Never summarise or repeat their answer back to them, and never praise or characterise it.";

  const facts = `DEPTH NOTICE: In "${header}", you have asked ${rounds} of the ${FOLLOW_UPS_PER_PHASE} follow-up questions for this phase.`;

  if (refused || declined) {
    return `${facts} They have said they have nothing more to add here, so ask nothing further and do not summarise what they wrote. ${onward}`;
  }

  if (rounds === 0) {
    return `${facts} The next one is the SCENE question, and for this phase it must be built from this exact form and no other: "${SCENE_FORMS[phaseIndex]}"${style}`;
  }

  if (rounds === 1) {
    return `${facts} The next one is the FELT EXPERIENCE question, and for this phase it must be built from this exact form and no other: "${FELT_FORMS[phaseIndex]}" It must hang off the specific scene they have just described.${style}`;
  }

  return `${facts} Both follow-ups are done, so ask nothing further in this phase and do not summarise what they wrote. ${onward}`;
}

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
    const { messages } = await request.json();
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

    // The exercise begins when the participant types Start after the
    // introduction — not at code entry, and not on page load.
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
        ? "START NOTICE: The participant has not typed Start yet, so the exercise has not begun. Do not open Phase 2 and do not treat their message as an answer to anything. Reply with one warm sentence asking them to type Start when they are ready, and nothing else."
        : null;

    const stats = phaseStats(messages);
    const last = messages[messages.length - 1];

    // Distress overrides everything: no classifier, no depth targets, no phase
    // machinery.
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

    // Asked what I am. Answered honestly, identically every time, then back to
    // the exercise.
    if (
      stats &&
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
      last &&
      last.role === "user" &&
      isStuck(last.content) &&
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
      last &&
      last.role === "user" &&
      !isDecline(last.content) &&
      !isStuck(last.content) &&
      !looksLikeQuestion(last.content) &&
      (stats.offTaskCount || 0) < MAX_OFF_TASK_REASKS &&
      !(await isOnTask(stats.header, last.content))
    ) {
      return Response.json({
        reply: OFF_TASK_REPLY,
        started: true,
        concluded: false,
      });
    }

    const notices = [startNotice ?? depthNotice(messages)].filter(Boolean);
    let reply = await ask(messages, notices, endCode);

    // Floor on session length: if the model tries to hand out the ending code
    // early, reject that reply and make it keep going.
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
