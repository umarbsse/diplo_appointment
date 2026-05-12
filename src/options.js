import {
  clearConfig,
  getConfig,
  SELECTOR_HELP,
  setConfig,
  URL_RULE_HELP,
  validateConfig,
  validateElementSelector,
  validateFormId,
  validateUrlRule
} from './config.js';

const form = document.querySelector('#optionsForm');
const inputs = {
  urlRule: document.querySelector('#urlRule'),
  formId: document.querySelector('#formId'),
  elementSelector: document.querySelector('#elementSelector')
};
const clearButton = document.querySelector('#clearButton');
const message = document.querySelector('#message');

form.addEventListener('submit', saveOptions);
clearButton.addEventListener('click', clearOptions);
Object.values(inputs).forEach((input) => input.addEventListener('input', validateCurrentInput));

document.addEventListener('DOMContentLoaded', restoreOptions);

async function restoreOptions() {
  const config = await getConfig();
  inputs.urlRule.value = config.urlRule;
  inputs.formId.value = config.formId;
  inputs.elementSelector.value = config.elementSelector;
  setMessage(`${URL_RULE_HELP} ${SELECTOR_HELP}`);
}

async function saveOptions(event) {
  event.preventDefault();

  try {
    const savedConfig = await setConfig(readForm());
    inputs.urlRule.value = savedConfig.urlRule;
    inputs.formId.value = savedConfig.formId;
    inputs.elementSelector.value = savedConfig.elementSelector;
    setMessage('Options saved.', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

async function clearOptions() {
  await clearConfig();
  inputs.urlRule.value = '';
  inputs.formId.value = '';
  inputs.elementSelector.value = '';
  setMessage('Options cleared.', 'success');
}

function validateCurrentInput() {
  const config = readForm();

  if (!config.urlRule && !config.formId && !config.elementSelector) {
    setMessage(`${URL_RULE_HELP} ${SELECTOR_HELP}`);
    return;
  }

  const validations = [
    validateUrlRule(config.urlRule),
    validateFormId(config.formId),
    validateElementSelector(config.elementSelector),
    validateConfig(config)
  ];

  const failed = validations.find((validation) => !validation.ok);
  setMessage(failed ? failed.reason : 'Options look valid.', failed ? 'error' : 'success');
}

function readForm() {
  return {
    urlRule: inputs.urlRule.value,
    formId: inputs.formId.value,
    elementSelector: inputs.elementSelector.value
  };
}

function setMessage(text, tone = '') {
  message.textContent = text;
  message.dataset.tone = tone;
}
