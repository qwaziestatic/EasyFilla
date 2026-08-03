// Centralized on ARIA roles/attributes rather than Google's obfuscated,
// build-specific CSS class names, which shift across deployments without notice.
export const SELECTORS = {
  questionItem: 'div[role="listitem"]',
  heading: '[role="heading"]',
  requiredMarker: '[aria-label="Required question"]',
  textInput:
    'input[type="text"], input[type="email"], input[type="url"], input[type="number"], input[type="tel"]',
  textarea: "textarea",
  radioOption: '[role="radio"]',
  checkboxOption: '[role="checkbox"]',
  listbox: '[role="listbox"]',
  listboxOption: '[role="option"]',
  table: '[role="table"]',
  row: '[role="row"]',
  columnHeader: '[role="columnheader"]',
  rowHeader: '[role="rowheader"]',
  fileInput: 'input[type="file"]',
  dateInput: 'input[type="date"]',
  timeInput: 'input[type="time"]',
  // Generic interactive-element check, used to tell an actual question
  // apart from a section title/description block that merely has heading
  // text but no answer widget at all.
  interactive:
    'input, textarea, select, [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [role="slider"], [contenteditable="true"]',
} as const;
