// Words in a systemd unit file, written so that systemd reads back exactly the text given.
// A percent sign starts a specifier on every line, so it is doubled. On a command line a
// dollar sign starts a variable, so it is doubled there; on an Environment= line it is plain
// text. Inside quotes only the backslash, the quote and line breaks are escaped: systemd
// keeps an escape it does not know as it stands, backslash included.
const PLAIN = /^[A-Za-z0-9_@+=:,./-]+$/;
const ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
function word(text, command) {
  const value = String(text);
  if (PLAIN.test(value)) return value;
  const doubled = value.replace(/%/g, '%%').replace(/\$/g, () => (command ? '$$' : '$'));
  return `"${doubled.replace(/[\\"\n\r\t]/g, found => ESCAPES[found])}"`;
}
// One word of ExecStart=.
export const unitArgument = value => word(value, true);
// One whole Environment= line.
export const unitEnvironment = (name, value) => `Environment=${word(`${name}=${value}`, false)}`;
