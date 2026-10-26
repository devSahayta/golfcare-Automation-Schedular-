require("dotenv").config();
const { runCleanup } = require("../src/jobs/productImportImageCleanup");

console.log("Running product import image cleanup test...");
runCleanup()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
