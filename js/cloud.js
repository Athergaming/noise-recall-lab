// ===== Noise & Recall Lab — shared database (Supabase REST API) =====
// Every trial is saved on this device first, then uploaded here so everyone's results can be
// combined. If the internet drops, trials wait on the device and upload later.

const CLOUD_COLUMNS = [
  'trialId', 'sessionId', 'groupName', 'participant', 'phase', 'orderGroup', 'block', 'trialInBlock',
  'trialNumber', 'condition', 'noiseType', 'intendedDb', 'gainDb', 'calibrated', 'sequenceId',
  'sequence', 'response', 'correct', 'length', 'percent', 'positionsCorrect', 'responseMs',
  'showSeconds', 'recallSeconds', 'deviceNote', 'timestamp',
];

// trialId -> trial_id (JavaScript style to database style)
function toSnakeCase(name) {
  return name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
}

const Cloud = {
  enabled: Boolean(typeof CLOUD_CONFIG !== 'undefined' && CLOUD_CONFIG.url && CLOUD_CONFIG.key),

  endpoint(path) {
    return CLOUD_CONFIG.url + '/rest/v1/' + path;
  },

  headers(extra = {}) {
    return { apikey: CLOUD_CONFIG.key, 'Content-Type': 'application/json', ...extra };
  },

  toRow(trial) {
    const row = {};
    for (const column of CLOUD_COLUMNS) row[toSnakeCase(column)] = trial[column] ?? null;
    row.group_name = row.group_name || '';
    return row;
  },

  fromRow(row) {
    const trial = { demo: false, synced: true };
    for (const column of CLOUD_COLUMNS) trial[column] = row[toSnakeCase(column)];
    for (const column of ['intendedDb', 'gainDb', 'percent', 'showSeconds', 'recallSeconds']) {
      if (trial[column] !== null && trial[column] !== undefined) trial[column] = Number(trial[column]);
    }
    return trial;
  },

  async errorText(response) {
    try {
      const body = await response.json();
      return body.message || response.statusText;
    } catch (error) {
      return response.statusText || 'HTTP ' + response.status;
    }
  },

  // Uploads trials. Trials that are already in the database are skipped, so retrying is safe.
  async upload(trials) {
    const response = await fetch(this.endpoint('trials?on_conflict=trial_id'), {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=minimal,resolution=ignore-duplicates' }),
      body: JSON.stringify(trials.map(trial => this.toRow(trial))),
    });
    if (!response.ok) throw new Error(await this.errorText(response));
  },

  // Downloads every trial, 1000 at a time.
  async fetchAll() {
    const trials = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const response = await fetch(this.endpoint('trials?select=*&order=timestamp.asc,trial_id.asc'), {
        headers: this.headers({ Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' }),
      });
      if (!response.ok) throw new Error(await this.errorText(response));
      const rows = await response.json();
      trials.push(...rows.map(row => this.fromRow(row)));
      if (rows.length < pageSize) return trials;
    }
  },

  async deleteTrials(ids, passcode) {
    const response = await fetch(this.endpoint('rpc/admin_delete_trials'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ passcode, ids }),
    });
    if (!response.ok) throw new Error(await this.errorText(response));
    return response.json();
  },
};
