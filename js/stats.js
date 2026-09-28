// ===== Noise & Recall Lab — statistics =====
// Every number on the Results tab is calculated here. Each function takes a list of
// values (or trials) and returns a number or a small object.

// ---------- Basic statistics ----------

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function mean(values) {
  return values.length ? sum(values) / values.length : NaN;
}

// Sample standard deviation: how spread out the scores are.
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  let squares = 0;
  for (const value of values) squares += (value - average) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

function summarize(values) {
  const n = values.length;
  const sd = standardDeviation(values);
  return {
    n,
    mean: mean(values),
    sd,
    se: n ? sd / Math.sqrt(n) : NaN, // standard error: how precise the mean is
    min: n ? Math.min(...values) : NaN,
    max: n ? Math.max(...values) : NaN,
  };
}

// ---------- Scoring one trial ----------

// One point for each digit recalled in the correct position.
function scoreResponse(sequence, response) {
  const positions = [];
  let correct = 0;
  for (let i = 0; i < sequence.length; i++) {
    const isCorrect = response[i] === sequence[i];
    positions.push(isCorrect);
    if (isCorrect) correct++;
  }
  return { correct, positions, percent: (100 * correct) / sequence.length };
}

// ---------- Probability distributions (for p-values) ----------

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of c) series += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

function betaContinuedFraction(a, b, x) {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return h;
}

function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

// Two-tailed p-value for a t statistic.
function tTestPValue(t, df) {
  if (!Number.isFinite(t)) return 0;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

// p-value for an F statistic (used by ANOVA).
function fTestPValue(F, df1, df2) {
  if (!Number.isFinite(F)) return 0;
  if (F <= 0) return 1;
  return incompleteBeta(df2 / (df2 + df1 * F), df2 / 2, df1 / 2);
}

// ---------- Tests ----------

// Line of best fit y = slope·x + intercept, with correlation r and a p-value for the slope.
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = r * Math.sqrt(df / Math.max(1e-12, 1 - r * r));
  return { slope, intercept: my - slope * mx, r, r2: r * r, t, df, p: tTestPValue(t, df), n };
}

// One-way ANOVA: are the group means more different than chance would explain?
function oneWayAnova(groups) {
  const valid = groups.filter(g => g.length > 0);
  const all = valid.flat();
  const k = valid.length;
  const N = all.length;
  if (k < 2 || N - k < 1) return null;
  const grand = mean(all);
  let between = 0, within = 0;
  for (const group of valid) {
    const m = mean(group);
    between += group.length * (m - grand) ** 2;
    for (const value of group) within += (value - m) ** 2;
  }
  const df1 = k - 1, df2 = N - k;
  if (within === 0) return null;
  const F = (between / df1) / (within / df2);
  return { F, df1, df2, p: fTestPValue(F, df1, df2) };
}

// Repeated-measures ANOVA: same idea, but it removes differences between people
// (some people just have better memory), which suits our within-subjects design.
// rows = participants, columns = conditions (every row must be complete).
function repeatedMeasuresAnova(matrix) {
  const n = matrix.length;
  const k = n ? matrix[0].length : 0;
  if (n < 2 || k < 2) return null;
  const grand = mean(matrix.flat());
  let ssConditions = 0, ssPeople = 0, ssTotal = 0;
  for (let j = 0; j < k; j++) ssConditions += n * (mean(matrix.map(row => row[j])) - grand) ** 2;
  for (const row of matrix) {
    ssPeople += k * (mean(row) - grand) ** 2;
    for (const value of row) ssTotal += (value - grand) ** 2;
  }
  const ssError = ssTotal - ssConditions - ssPeople;
  const df1 = k - 1, df2 = (k - 1) * (n - 1);
  if (ssError <= 1e-9) return null;
  const F = (ssConditions / df1) / (ssError / df2);
  return { F, df1, df2, p: fTestPValue(F, df1, df2), n };
}

// ---------- Putting it together ----------

function groupBy(list, keyFn) {
  const groups = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// Participants are identified by group + code, so two groups can both have a "P1".
function participantKey(trial) {
  return trial.groupName ? trial.groupName + ' · ' + trial.participant : trial.participant;
}

function conditionLabel(key) {
  return key === 'quiet' ? 'Quiet' : key + ' dB';
}

// x-value for graphs: noise level in dB, or the measured room level for the quiet control.
function trialDb(trial, settings) {
  return trial.condition === 'quiet' ? settings.quietRoomDb : Number(trial.intendedDb);
}

function analyzeTrials(allTrials, settings) {
  const trials = allTrials.filter(t => t.phase === 'main');
  const percents = list => list.map(t => t.percent);

  // Conditions found in the data, from quietest to loudest.
  const conditionKeys = [...new Set(trials.map(t => t.condition))]
    .sort((a, b) => (a === 'quiet' ? -1 : Number(a)) - (b === 'quiet' ? -1 : Number(b)));
  const byConditionMap = groupBy(trials, t => t.condition);
  const conditions = conditionKeys.map(key => ({
    key,
    label: conditionLabel(key),
    x: key === 'quiet' ? settings.quietRoomDb : Number(key),
    stats: summarize(percents(byConditionMap.get(key))),
  }));
  const noisyKeys = conditionKeys.filter(k => k !== 'quiet');

  // Each noise type at each level (only the types that were actually used).
  const types = NOISE_TYPES.filter(type => trials.some(t => t.noiseType === type));
  const byType = {};
  const typeOverall = {};
  for (const type of types) {
    const typeTrials = trials.filter(t => t.noiseType === type);
    typeOverall[type] = summarize(percents(typeTrials));
    byType[type] = noisyKeys.map(key => ({
      key,
      label: conditionLabel(key),
      x: Number(key),
      stats: summarize(percents(typeTrials.filter(t => t.condition === key))),
    }));
  }

  // Each participant's mean at each condition.
  const participants = [...new Set(trials.map(participantKey))].sort();
  const participantTable = participants.map(code => {
    const own = trials.filter(t => participantKey(t) === code);
    const cells = {};
    for (const key of conditionKeys) cells[key] = summarize(percents(own.filter(t => t.condition === key)));
    return { participant: code, cells, overall: summarize(percents(own)) };
  });

  // Serial position: % correct at each position in the sequence, per condition.
  const maxLength = trials.reduce((max, t) => Math.max(max, t.length || 0), 0);
  const serialPosition = conditionKeys.map(key => {
    const own = byConditionMap.get(key);
    const values = [];
    for (let position = 0; position < maxLength; position++) {
      const hits = own.filter(t => (t.positionsCorrect || '').length > position);
      const correct = hits.filter(t => t.positionsCorrect[position] === 'Y').length;
      values.push(hits.length ? (100 * correct) / hits.length : NaN);
    }
    return { key, label: conditionLabel(key), values };
  });

  // Order check: did people just get better (practice) or worse (tired) over time?
  const blockNumbers = [...new Set(trials.map(t => t.block))].sort((a, b) => a - b);
  const byBlock = blockNumbers.map(block => ({ block, stats: summarize(percents(trials.filter(t => t.block === block))) }));

  // Tests
  const regression = linearRegression(trials.map(t => trialDb(t, settings)), percents(trials));
  const anova = oneWayAnova(conditionKeys.map(key => percents(byConditionMap.get(key))));
  const completeRows = participantTable.filter(row => conditionKeys.every(key => row.cells[key].n > 0));
  const rmAnova = repeatedMeasuresAnova(completeRows.map(row => conditionKeys.map(key => row.cells[key].mean)));
  const typeAnova = types.length > 1 ? oneWayAnova(types.map(type => percents(trials.filter(t => t.noiseType === type)))) : null;

  const quiet = conditions.find(c => c.key === 'quiet');
  const loudest = conditions.length ? conditions[conditions.length - 1] : null;
  const drop = quiet && loudest && loudest.key !== 'quiet' ? loudest.stats.mean - quiet.stats.mean : NaN;

  return {
    trialCount: trials.length,
    participants,
    conditions,
    types,
    byType,
    typeOverall,
    participantTable,
    serialPosition,
    byBlock,
    regression,
    anova,
    rmAnova,
    typeAnova,
    quiet,
    loudest,
    drop,
    verdict: makeVerdict(regression, conditions),
  };
}

function makeVerdict(regression, conditions) {
  if (!regression || conditions.length < 2) {
    return { tone: 'none', title: 'Not enough data yet', text: 'Run at least one participant through two or more noise levels to test the hypothesis.' };
  }
  const per10 = regression.slope * 10;
  const p = regression.p;
  const pText = p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3);
  if (regression.slope < 0 && p < 0.05) {
    return {
      tone: 'support',
      title: 'Supports the alternative hypothesis',
      text: `Recall accuracy went down as noise got louder: about ${Math.abs(per10).toFixed(1)} percentage points lower for every 10 dB (${pText}). Because p < 0.05, we reject the null hypothesis.`,
    };
  }
  if (regression.slope < 0) {
    return {
      tone: 'trend',
      title: 'Trend in the predicted direction, not significant',
      text: `Scores dropped about ${Math.abs(per10).toFixed(1)} points per 10 dB, but ${pText} is above 0.05, so with this sample we cannot reject the null hypothesis. More participants would give a clearer answer.`,
    };
  }
  return {
    tone: 'none',
    title: 'Does not support the alternative hypothesis',
    text: `Scores did not go down as noise got louder (change of ${per10 >= 0 ? '+' : ''}${per10.toFixed(1)} points per 10 dB, ${pText}). We fail to reject the null hypothesis.`,
  };
}

// Pilot: accuracy for each sequence length, and a suggested length for the real test.
function analyzePilot(allTrials) {
  const pilot = allTrials.filter(t => t.phase === 'pilot');
  const byLength = groupBy(pilot, t => t.length);
  const rows = [...byLength.keys()].sort((a, b) => a - b)
    .map(length => ({ length, stats: summarize(byLength.get(length).map(t => t.percent)) }));
  // Aim for ~75% in quiet: hard enough that noise can lower it, easy enough not to hit the floor.
  let suggestion = null;
  for (const row of rows) {
    if (!suggestion || Math.abs(row.stats.mean - 75) < Math.abs(suggestion.stats.mean - 75)) suggestion = row;
  }
  return { rows, suggestion, count: pilot.length };
}
