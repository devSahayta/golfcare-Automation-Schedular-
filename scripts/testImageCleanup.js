require("dotenv").config();
const { runCleanup } = require("../src/jobs/campaignImageCleanup");

console.log("Running campaign image cleanup test...");
runCleanup()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
