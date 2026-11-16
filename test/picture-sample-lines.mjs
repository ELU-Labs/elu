// What test/picture-sample.mjs says of the terminal it ran in. answered: { protocol, name, cell }
// of the screen's pictures (lib/terminal-pictures.mjs). told: what the switches say
// (pictureSwitch). inside: tmux or screen is around it, as the environment says.

// What the terminal answered, in a line.
export function answerLine({ protocol, name, cell }, told, inside = false) {
  const who = name ? `This terminal (${name})` : 'This terminal';
  if (protocol === null) return 'Asking this terminal whether it shows pictures…';
  if (protocol === 'off') {
    if (told === 'off') return `Pictures are off here${inside ? ' (inside tmux)' : ''}: the text chart.`;
    return `${who} ${name ? 'said it shows no pictures' : 'did not say who it is'}: the text chart.`;
  }
  const how = protocol === 'kitty' ? 'the Kitty graphics protocol' : 'the iTerm2 inline-image protocol';
  return `${who} shows pictures by ${how}${told === 'ask' ? '' : ', as told'}.${cell ? ` A cell is ${cell.width}x${cell.height} pixels.` : ''}`;
}

// After q: what to try next, or '' where there is nothing to try. Only a terminal that did not
// say who it is may show pictures all the same: one that named itself (tmux too) has said no.
export function adviceLine({ protocol, name }, told) {
  return protocol === 'off' && told === 'ask' && !name ? 'If it shows pictures all the same: ELU_PICTURES=kitty node test/picture-sample.mjs' : '';
}
