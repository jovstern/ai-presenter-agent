// The live e2e's view of a conversation (e2e/live.spec.js, issue #29): what
// passed over the real Gemini Live socket, minus the audio, and the agent's
// speech cut into turns so a doubled answer can be counted.

/**
 * One non-audio message over the Live socket. `out` is the page to Gemini,
 * `in` Gemini to the page; `t` is ms since the tap started.
 * @typedef {object} TapEvent
 * @property {number} t
 * @property {number} socket The socket's index, in the order the page opened them.
 * @property {'in' | 'out'} dir
 * @property {string} kind `setup`, `snapshot`, `knowledge`, `greeting`, `corrective`,
 *   `text` (another client turn) or `toolResponse` going out; `outputTranscription`,
 *   `inputTranscription`, `turnComplete`, `generationComplete`, `interrupted`,
 *   `toolCall` or `toolCallCancellation` coming in.
 * @property {string} [text] A transcription fragment.
 * @property {string[]} [names] A tool call's or tool response's function names.
 */

/**
 * The agent's speech between two boundaries: the end of its turn
 * (`turnComplete`), a barge-in (`interrupted`), a tool call, or a drop (`open`).
 * @typedef {object} AgentTurn
 * @property {string} text
 * @property {string} after What the page last sent (or `user`, the user's speech) before the
 *   turn's first word: what prompted it.
 * @property {'turnComplete' | 'interrupted' | 'toolCall' | 'open'} end
 * @property {boolean} userBefore The user spoke since the agent's previous turn.
 */

/**
 * Classifies a client turn by the text liveSession.js sends.
 * @param {string} text
 */
export function clientTurnKind(text) {
  if (text.startsWith('Page snapshot')) return 'snapshot';
  if (text.startsWith('Knowledge context') || text.startsWith('STRICT RULES')) return 'knowledge';
  if (text.startsWith('Greet the user')) return 'greeting';
  if (text.startsWith('You are repeating yourself')) return 'corrective';
  return 'text';
}

/**
 * @param {unknown} value
 * @param {...string} path
 * @returns {unknown} The value at `path`, or undefined.
 */
function at(value, ...path) {
  return path.reduce(
    (/** @type {unknown} */ node, key) =>
      typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined,
    value,
  );
}

/** @param {unknown} value */
function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * One raw Live frame as TapEvents; audio and bookkeeping frames give none.
 * @param {string | Buffer} message
 * @param {'in' | 'out'} dir
 * @param {number} socket
 * @param {number} t
 * @returns {TapEvent[]}
 */
export function tapEvents(message, dir, socket, t) {
  /** @type {unknown} */
  let frame;
  try {
    frame = JSON.parse(String(message));
  } catch {
    return [];
  }
  /** @type {TapEvent[]} */
  const events = [];
  /**
   * @param {string} kind
   * @param {{ text?: string, names?: string[] }} [rest]
   */
  const push = (kind, rest = {}) => events.push({ t, socket, dir, kind, ...rest });
  if (dir === 'out') {
    if (at(frame, 'setup')) push('setup');
    const turns = at(frame, 'clientContent', 'turns');
    if (turns !== undefined) {
      // sendClientContent's string turn arrives as Content objects with parts.
      const text = list(turns)
        .flatMap((turn) => list(at(turn, 'parts')))
        .map((part) => str(at(part, 'text')))
        .join('');
      push(clientTurnKind(text));
    }
    const responses = at(frame, 'toolResponse', 'functionResponses');
    if (responses !== undefined) {
      push('toolResponse', { names: list(responses).map((r) => str(at(r, 'name'))) });
    }
    return events;
  }
  const input = str(at(frame, 'serverContent', 'inputTranscription', 'text'));
  if (input) push('inputTranscription', { text: input });
  const output = str(at(frame, 'serverContent', 'outputTranscription', 'text'));
  if (output) push('outputTranscription', { text: output });
  for (const flag of ['interrupted', 'generationComplete', 'turnComplete']) {
    if (at(frame, 'serverContent', flag)) push(flag);
  }
  const calls = at(frame, 'toolCall', 'functionCalls');
  if (calls !== undefined) {
    push('toolCall', { names: list(calls).map((c) => str(at(c, 'name'))) });
  }
  if (at(frame, 'toolCallCancellation')) push('toolCallCancellation');
  return events;
}

/**
 * Cuts the agent's speech into turns (AgentTurn).
 * @param {TapEvent[]} events
 * @returns {AgentTurn[]}
 */
export function agentTurns(events) {
  /** @type {AgentTurn[]} */
  const turns = [];
  /** @type {AgentTurn | null} */
  let current = null;
  let after = 'none';
  let userBefore = false;
  let socket = 0;
  /** @param {AgentTurn['end']} end */
  const close = (end) => {
    const text = current?.text.replace(/\s+/g, ' ').trim();
    if (current && text) {
      turns.push({ ...current, text, end });
      userBefore = false;
    }
    current = null;
  };
  for (const event of events) {
    if (event.socket !== socket) {
      close('open');
      socket = event.socket;
    }
    if (event.dir === 'out') {
      if (event.kind !== 'setup') after = event.kind;
      continue;
    }
    switch (event.kind) {
      case 'inputTranscription':
        after = 'user';
        userBefore = true;
        break;
      case 'outputTranscription':
        current ??= { text: '', after, end: 'open', userBefore };
        current.text += event.text ?? '';
        break;
      case 'turnComplete':
      case 'interrupted':
      case 'toolCall':
        close(event.kind);
        break;
      default:
        break;
    }
  }
  close('open');
  return turns;
}

/** @param {string} text */
function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} text A normalised text. */
function wordCount(text) {
  return text ? text.split(' ').length : 0;
}

// Shorter repeats ("Okay.", "How are you?") are ordinary speech, not a doubled answer.
const MIN_WORDS = 4;

/** @param {string} text */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s*/)
    .map((sentence) => ({ sentence: sentence.trim(), key: normalise(sentence) }))
    .filter(({ key }) => wordCount(key) >= MIN_WORDS);
}

/**
 * A doubled answer: a sentence (of MIN_WORDS words or more) the agent says
 * again in the turn that follows, or twice in one turn. `userBetween` says the
 * user spoke before the repeat, as in issue #29's report. Narrating a repeated
 * action is not one: two turns that each end in a tool call ("I'll increment
 * the counter." twice, for "increment it twice").
 * @typedef {{ text: string, userBetween: boolean }} Double
 */

/**
 * @param {AgentTurn[]} turns
 * @returns {Double[]}
 */
export function doubledTurns(turns) {
  /** @type {Double[]} */
  const doubles = [];
  turns.forEach((turn, index) => {
    const previous = turns[index - 1];
    const narration = previous?.end === 'toolCall' && turn.end === 'toolCall';
    const before = previous && !narration ? normalise(previous.text) : '';
    const seen = new Set();
    for (const { sentence, key } of sentences(turn.text)) {
      if (seen.has(key)) doubles.push({ text: sentence, userBetween: false });
      else if (` ${before} `.includes(` ${key} `))
        doubles.push({ text: sentence, userBetween: turn.userBefore });
      seen.add(key);
    }
  });
  return doubles;
}
