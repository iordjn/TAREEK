/* Recursive JSON editing and review helpers. Never split keys on periods. */
const configPointer = path => path.length ? '/' + path.map(key => String(key).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : '';
const configType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const unsafeConfigKey = key => ['__proto__', 'constructor', 'prototype'].includes(String(key));
const credentialConfigKey = key => /apikey|password|passwd|secret|token|credential|authorization|privatekey|accesskey|username|clientid|cookie/i.test(String(key).replace(/[^a-z0-9]/gi, ''));
function hiddenConfigPath(path) {
  return path.some(key => String(key).startsWith('_') || credentialConfigKey(key)) ||
    JSON.stringify(path) === JSON.stringify(['coordinates', 'utm_epsg']);
}
function privateConfigURL(value) {
  if (typeof value !== 'string' || !value.includes('://')) return false;
  try {
    const url = new URL(value);
    return !!(url.username || url.password) || [...url.searchParams.keys()].some(credentialConfigKey);
  } catch { return true; }
}

// Optional metadata uses JSON Pointer keys. Help annotations in the loaded
// config (or baseline) supply descriptions for fields without explicit metadata.
const CONFIG_METADATA = {
  '/data/day_type': {enum: ['weekday', 'weekend', 'all']},
  '/data/survey_months': {types: ['string', 'array'], description: "'regular', 'all', or an array of month numbers (1–12)."},
  '/matsim/mode': {enum: ['basic', 'uber']},
  '/matsim/configurable_params/lastIteration': {minimum: 0, integer: true},
  '/matsim/configurable_params/qsim.flowCapacityFactor': {exclusiveMinimum: 0},
  '/matsim/configurable_params/qsim.storageCapacityFactor': {exclusiveMinimum: 0},
  '/plan_generation/scaling_factor': {exclusiveMinimum: 0},
  '/plan_generation/num_processes': {minimum: 1, integer: true},
  '/od_matrix/source': {enum: ['auto', 'lodes_od', 'gravity']},
  '/od_matrix/boundary_policy': {enum: ['drop', 'anchor']},
  '/od_matrix/distance': {enum: ['cosine_km', 'legacy_degrees']},
  '/od_matrix/friction': {enum: ['power', 'exponential', 'gamma']},
  '/duration_constraints/over_budget': {enum: ['trim', 'resample']},
  '/time_models/first_departure_source': {enum: ['all_trips', 'first_of_day']},
  '/network/roundabout_capacity_per_lane': {types: ['null', 'number'], exclusiveMinimum: 0},
};

function configDifferences(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
      hiddenConfigPath([...path, key]) ? [] : configDifferences(before[key], after[key], [...path, key]));
  }
  return hiddenConfigPath(path) ? [] : [{path, before, after}];
}

function safeReviewValue(value) {
  function redact(item) {
    if (privateConfigURL(item)) return '[credential URL hidden]';
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !hiddenConfigPath([key])).map(([key, child]) => [key, redact(child)]));
    return item;
  }
  return value === undefined ? '(absent)' : JSON.stringify(redact(value), null, 2);
}

class AdvancedConfigEditor {
  constructor(state, container, metadata = {}, baseline = () => null) {
    this.state = state; this.container = container; this.metadata = metadata; this.baseline = baseline;
    this.errors = new Map(); this.drafts = new Map(); this.sequence = 0;
    state.subscribe(change => {
      if (change.source === 'load') { this.errors.clear(); this.drafts.clear(); this.render(); }
      else if (change.source !== 'advanced') { this.clearErrors(change.path); this.render(); }
    });
  }
  fieldMetadata(path) {
    const pointer = configPointer(path);
    const get = (obj, keys) => keys.reduce((value, key) => value?.[key], obj);
    const parent = path.slice(0, -1), key = path.at(-1);
    const help = get(this.state.config, [...parent, `_${key}_help`]) ?? get(this.baseline(), [...parent, `_${key}_help`]);
    return {...(typeof help === 'string' && !privateConfigURL(help) ? {description: help} : {}),
      ...CONFIG_METADATA[pointer], ...this.metadata[pointer]};
  }
  errorsList() { return [...this.errors].map(([path, message]) => `${path}: ${message}`); }
  commit(path, value) {
    this.errors.delete(configPointer(path));
    this.drafts.delete(configPointer(path));
    this.state.set(path, value, 'advanced');
  }
  render() {
    // Restore open groups after changes from the wizard or array/object edits.
    const open = new Set([...this.container.querySelectorAll('details[open]')].map(el => el.dataset.path));
    this.container.replaceChildren();
    if (!this.state.config) return;
    for (const [key, value] of Object.entries(this.state.config)) {
      if (!hiddenConfigPath([key])) this.container.appendChild(this.node([key], value));
    }
    this.container.querySelectorAll('details').forEach(el => { el.open = open.has(el.dataset.path); });
  }
  node(path, value) {
    const pointer = configPointer(path), type = configType(value), metadata = this.fieldMetadata(path);
    const wrapper = document.createElement('div'); wrapper.className = 'advanced-field';
    wrapper.dataset.pointer = pointer;
    if (path.some(unsafeConfigKey) || privateConfigURL(value) || !['object', 'array', 'string', 'number', 'boolean', 'null'].includes(type)) {
      wrapper.textContent = `${pointer}: preserved without editing (private or unsupported value).`;
      return wrapper;
    }
    const id = `advanced-${++this.sequence}`;
    const label = document.createElement('label'); label.htmlFor = id; label.className = 'form-label';
    label.textContent = String(path.at(-1)); wrapper.appendChild(label);
    if (metadata.description) {
      const description = document.createElement('p'); description.className = 'form-hint';
      description.id = `${id}-help`; description.textContent = metadata.description; wrapper.appendChild(description);
    }
    const error = document.createElement('p'); error.className = 'preset-error text-sm';
    error.id = `${id}-error`; error.setAttribute('aria-live', 'polite');
    error.textContent = this.errors.get(pointer) || '';
    const types = document.createElement('select'); types.className = 'form-select advanced-type';
    types.setAttribute('aria-label', `${pointer} value type`);
    const allowedTypes = metadata.types || ['string', 'number', 'boolean', 'null', 'object', 'array'];
    for (const optionType of new Set([...allowedTypes, type])) {
      const option = document.createElement('option'); option.value = optionType;
      option.textContent = optionType; types.appendChild(option);
    }
    types.value = type;
    types.addEventListener('change', () => {
      const defaults = {string: '', number: 0, boolean: false, null: null, object: {}, array: []};
      if ((type === 'object' || type === 'array') && Object.keys(value).length &&
          !window.confirm(`Replace the complete value at ${pointer}?`)) { types.value = type; return; }
      // A parent container with hidden values must never expose or replace them.
      this.clearErrors(path); this.commit(path, defaults[types.value]); this.render();
    });
    wrapper.appendChild(types);
    if (type === 'object' || type === 'array') {
      // Type replacement of a container with protected descendants is disabled.
      if (this.hasProtected(value, path)) types.disabled = true;
      const group = document.createElement('details'); group.dataset.path = pointer;
      const summary = document.createElement('summary'); summary.textContent = `${path.at(-1)} · ${Object.keys(value).filter(key => !hiddenConfigPath([...path, key])).length} ${type === 'array' ? 'items' : 'fields'}`;
      group.appendChild(summary); label.htmlFor = ''; label.classList.add('sr-only');
      const children = document.createElement('div'); children.className = 'advanced-children';
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, type === 'array' ? Number(key) : key];
        if (hiddenConfigPath(childPath)) continue;
        const childNode = this.node(childPath, child);
        if (type === 'array' && !this.hasProtected(child, childPath)) {
          const remove = this.button(`Remove item ${key}`, () => {
            const items = structuredClone(this.state.get(path)); items.splice(Number(key), 1);
            this.clearErrors(path); this.commit(path, items); this.render();
          });
          childNode.appendChild(remove);
        }
        children.appendChild(childNode);
      }
      if (type === 'array') children.appendChild(this.button('Add item', () => {
        const items = structuredClone(this.state.get(path)); items.push(null);
        this.commit(path, items); this.render();
      }));
      else {
        const keyInput = document.createElement('input'); keyInput.className = 'form-input';
        keyInput.placeholder = 'New parameter name'; keyInput.setAttribute('aria-label', `${pointer} new parameter name`);
        children.appendChild(keyInput);
        children.appendChild(this.button('Add parameter', () => {
          const key = keyInput.value;
          if (!key || Object.hasOwn(this.state.get(path), key) || hiddenConfigPath([...path, key]) || unsafeConfigKey(key)) {
            keyInput.setCustomValidity('Use a new, non-private parameter name.'); keyInput.reportValidity(); return;
          }
          this.commit([...path, key], null); this.render();
        }));
        keyInput.addEventListener('input', () => keyInput.setCustomValidity(''));
      }
      group.appendChild(children); wrapper.appendChild(group);
    } else if (type === 'null') {
      const hint = document.createElement('span'); hint.className = 'form-hint';
      hint.textContent = 'null — select a type to supply a value'; wrapper.appendChild(hint);
      label.htmlFor = ''; types.id = id;
    } else {
      let input;
      if (metadata.enum && type === 'string') {
        input = document.createElement('select');
        // Preserve values outside a newer enum; do not silently select a default.
        for (const choice of new Set([...metadata.enum, value])) {
          const option = document.createElement('option'); option.value = choice; option.textContent = choice; input.appendChild(option);
        }
      } else input = document.createElement('input');
      input.id = id; input.dataset.configPointer = pointer;
      input.className = type === 'boolean' ? 'advanced-checkbox' : 'form-input';
      if (type === 'boolean') { input.type = 'checkbox'; input.checked = value; }
      else {
        if (input.tagName === 'INPUT') input.type = type === 'number' ? 'number' : 'text';
        input.value = String(value);
        if (type === 'number') {
          input.step = metadata.integer ? '1' : 'any';
          if (metadata.minimum !== undefined) input.min = metadata.minimum;
          if (metadata.maximum !== undefined) input.max = metadata.maximum;
        }
      }
      input.setAttribute('aria-describedby', `${metadata.description ? `${id}-help ` : ''}${id}-error`);
      if (this.drafts.has(pointer)) {
        input.value = this.drafts.get(pointer);
        input.setCustomValidity(this.errors.get(pointer) || 'Invalid value');
        input.setAttribute('aria-invalid', 'true');
      }
      input.addEventListener('input', () => {
        let next = type === 'boolean' ? input.checked : type === 'number' ? Number(input.value) : input.value;
        const invalid = type === 'number' && (input.value === '' || !Number.isFinite(next) ||
          (metadata.integer && !Number.isInteger(next)) ||
          (metadata.minimum !== undefined && next < metadata.minimum) ||
          (metadata.maximum !== undefined && next > metadata.maximum) ||
          (metadata.exclusiveMinimum !== undefined && next <= metadata.exclusiveMinimum));
        const message = invalid ? 'Enter a valid number within the allowed range.' : '';
        input.setCustomValidity(message); error.textContent = message;
        input.setAttribute('aria-invalid', String(!!message));
        if (message) { this.errors.set(pointer, message); this.drafts.set(pointer, input.value); }
        else this.commit(path, next);
        this.container.dispatchEvent(new Event('editor-validation'));
      });
      wrapper.appendChild(input);
    }
    wrapper.appendChild(error);
    return wrapper;
  }
  hasProtected(value, path) {
    if (hiddenConfigPath(path) || path.some(unsafeConfigKey) || privateConfigURL(value)) return true;
    return value && typeof value === 'object' && Object.entries(value).some(([key, child]) => this.hasProtected(child, [...path, key]));
  }
  clearErrors(path) {
    const pointer = configPointer(path);
    for (const key of this.errors.keys()) if (key === pointer || key.startsWith(pointer + '/')) {
      this.errors.delete(key); this.drafts.delete(key);
    }
  }
  button(text, action) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'btn btn--secondary'; button.textContent = text; button.onclick = action; return button;
  }
}

if (typeof module !== 'undefined') module.exports = {configPointer, configDifferences, safeReviewValue, hiddenConfigPath};
