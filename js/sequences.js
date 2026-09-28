// ===== Noise & Recall Lab — sequences and the testing plan =====

const NOISE_TYPES = ['talking', 'white', 'construction'];

// A seeded random number generator (mulberry32). The same seed always gives the same
// numbers, so every participant gets sequences from the same bank.
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Fisher–Yates shuffle: returns a new list in random order.
function shuffle(list, random) {
  const result = list.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Keeps difficulty similar: a digit is never next to itself or to a "neighbour" number
// (like 4-5 or 8-7), because those are easier to chunk, and no digit is used more often
// than it has to be (once for up to 9 digits, twice for up to 18, …).
function makeSequence(length, random) {
  const maxUses = Math.ceil(length / 9);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let digits = '';
    const uses = {};
    while (digits.length < length) {
      const previous = digits ? Number(digits[digits.length - 1]) : null;
      const options = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d =>
        (uses[d] || 0) < maxUses && (previous === null || Math.abs(d - previous) > 1));
      if (!options.length) break; // dead end: start again
      const digit = options[Math.floor(random() * options.length)];
      digits += digit;
      uses[digit] = (uses[digit] || 0) + 1;
    }
    if (digits.length === length) return digits;
  }
  throw new Error('Could not make a sequence of length ' + length);
}

function generateSequenceBank(count, length, seed) {
  const random = createRandom(seed + length * 1000);
  const bank = [];
  const used = new Set();
  while (bank.length < count) {
    const digits = makeSequence(length, random);
    if (used.has(digits)) continue;
    used.add(digits);
    bank.push({ id: 'S' + String(bank.length + 1).padStart(2, '0'), digits });
  }
  return bank;
}

// The quiet control plus each noise level, in increasing loudness.
function getConditions(settings) {
  const conditions = [{ key: 'quiet', label: 'Quiet', db: null }];
  for (const db of settings.noiseLevels) {
    conditions.push({ key: String(db), label: db + ' dB', db });
  }
  return conditions;
}

// Balanced Latin square: every condition appears in every position once, and each
// condition follows every other condition equally often. This spreads practice and
// tiredness evenly across the noise levels.
function latinSquareRow(size, rowIndex) {
  const firstRow = [0];
  let low = 1;
  let high = size - 1;
  for (let i = 1; i < size; i++) {
    firstRow.push(i % 2 === 1 ? low++ : high--);
  }
  return firstRow.map(value => (value + rowIndex) % size);
}

function orderGroupName(index) {
  return String.fromCharCode(65 + index); // 0 -> A, 1 -> B, ...
}

function describeOrder(orderIndex, settings) {
  const conditions = getConditions(settings);
  return latinSquareRow(conditions.length, orderIndex).map(i => conditions[i].label).join(' → ');
}

// The noise types chosen in settings (default: talking only).
function activeNoiseTypes(settings) {
  const chosen = NOISE_TYPES.filter(type => (settings.noiseTypes || NOISE_TYPES).includes(type));
  return chosen.length ? chosen : ['talking'];
}

// Spreads the chosen noise types evenly inside one noise level, then shuffles them.
function balancedNoiseTypes(count, random, types) {
  const startAt = Math.floor(random() * types.length);
  const list = [];
  for (let i = 0; i < count; i++) list.push(types[(startAt + i) % types.length]);
  return shuffle(list, random);
}

// Builds the full list of blocks and trials for one participant.
function buildSessionPlan(participantCode, orderIndex, settings) {
  const conditions = getConditions(settings);
  const perLevel = settings.trialsPerLevel;
  const bank = generateSequenceBank(conditions.length * perLevel, settings.sequenceLength, settings.bankSeed);
  const random = createRandom(hashString(participantCode) + settings.bankSeed);
  const order = latinSquareRow(conditions.length, orderIndex);

  const blocks = order.map(conditionIndex => {
    const condition = conditions[conditionIndex];
    // Sequence sets rotate, so each set is heard at a different level by different people.
    const setIndex = (conditionIndex + orderIndex) % conditions.length;
    const sequences = shuffle(bank.slice(setIndex * perLevel, (setIndex + 1) * perLevel), random);
    const noiseTypes = condition.db === null
      ? sequences.map(() => 'none')
      : balancedNoiseTypes(perLevel, random, activeNoiseTypes(settings));
    return {
      condition,
      setName: orderGroupName(setIndex),
      trials: sequences.map((sequence, i) => ({
        sequenceId: sequence.id,
        digits: sequence.digits,
        noiseType: noiseTypes[i],
      })),
    };
  });

  return { phase: 'main', orderIndex, blocks };
}

// Pilot: quiet trials that get longer, to choose the sequence length for the real test.
function buildPilotPlan(lengths, trialsPerLength) {
  const random = createRandom(Date.now());
  const trials = [];
  for (const length of lengths) {
    for (let i = 0; i < trialsPerLength; i++) {
      trials.push({ sequenceId: 'PILOT-' + length + '-' + (i + 1), digits: makeSequence(length, random), noiseType: 'none' });
    }
  }
  return {
    phase: 'pilot',
    orderIndex: null,
    blocks: [{ condition: { key: 'quiet', label: 'Quiet', db: null }, setName: 'pilot', trials }],
  };
}
