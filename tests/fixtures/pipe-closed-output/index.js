const chunk = "x".repeat(64 * 1024);
for (;;) process.stdout.write(chunk);
