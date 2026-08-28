// scripts/testSamvaadikAdapter.js
//
// Manual smoke test for the Samvaadik adapter. Modes:
//
//   node scripts/testSamvaadikAdapter.js
//     -> calls listTemplates() only. Read-only, safe to run anytime.
//
//   node scripts/testSamvaadikAdapter.js sendText <phone> "<message>"
//     -> sends a real WhatsApp text message. Needs the 24h window open
//     (message your business number from <phone> first).
//
//   node scripts/testSamvaadikAdapter.js sendTemplate <phone> <templateName> [var1] [var2] ...
//     -> sends a real template message. Does NOT need the 24h window open.
//     Pass template variables as extra args in order, e.g.:
//       node scripts/testSamvaadikAdapter.js sendTemplate 9198... order_notification "Order #123" "Shipped"
//
//   node scripts/testSamvaadikAdapter.js sendInteractive <phone> "<bodyText>" <btn1Label> [btn2Label] [btn3Label]
//     -> sends up to 3 quick-reply buttons. Needs the 24h window open.

require("dotenv").config();
const adapter = require("../src/lib/samvaadik/adapter");

async function main() {
  const [, , mode, ...rest] = process.argv;

  if (mode === "sendText") {
    const [phone, message] = rest;
    if (!phone || !message) {
      console.error(
        'Usage: node scripts/testSamvaadikAdapter.js sendText <phone> "<message>"',
      );
      process.exit(1);
    }
    console.log(`Sending test text to ${phone}...`);
    const result = await adapter.sendText(phone, message);
    console.log("Sent:", result);
    return;
  }

  if (mode === "sendTemplate") {
    const [phone, templateName, ...variables] = rest;
    if (!phone || !templateName) {
      console.error(
        "Usage: node scripts/testSamvaadikAdapter.js sendTemplate <phone> <templateName> [var1] [var2] ...",
      );
      process.exit(1);
    }
    console.log(
      `Sending template "${templateName}" to ${phone} with variables:`,
      variables,
    );
    const result = await adapter.sendTemplate(phone, templateName, variables);
    console.log("Sent:", result);
    return;
  }

  if (mode === "sendInteractive") {
    const [phone, bodyText, ...buttonLabels] = rest;
    if (!phone || !bodyText || buttonLabels.length === 0) {
      console.error(
        'Usage: node scripts/testSamvaadikAdapter.js sendInteractive <phone> "<bodyText>" <btn1Label> [btn2Label] [btn3Label]',
      );
      process.exit(1);
    }
    const buttons = buttonLabels.map((label, i) => ({
      id: `btn_${i + 1}`,
      label,
    }));
    console.log(
      `Sending interactive message to ${phone} with buttons:`,
      buttonLabels,
    );
    const result = await adapter.sendInteractive(phone, bodyText, buttons);
    console.log("Sent:", result);
    return;
  }

  console.log("Fetching templates (read-only test)...");
  const templates = await adapter.listTemplates();
  console.log(`Found ${templates.length} approved template(s):`);
  console.table(
    templates.map((t) => ({
      name: t.name,
      category: t.category,
      language: t.language,
      status: t.status,
    })),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test failed:", err.message);
    process.exit(1);
  });
