const events: string[] = [];
process.stdin.on('end', () => events.push('end'));
setTimeout(() => {
  console.log(events.length);
  process.stdin.on('data', bytes => console.log(bytes.toString().trim()));
  process.stdin.once('end', () => console.log(events.join(',')));
}, 5);
