const stream = process.argv[2] === "2" ? process.stderr : process.stdout;
stream.write("x".repeat(8 * 1024 * 1024));
