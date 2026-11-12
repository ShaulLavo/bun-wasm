process.stdin.on("data", chunk => process.stdout.write(String(chunk).toUpperCase()));
