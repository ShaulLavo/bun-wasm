console.log(process.argv[2]);
process.once("message", (message) => {
  process.send({ received: message }, (error) => {
    if (error) throw error;
    process.disconnect();
  });
});
