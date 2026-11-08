import { getIdentity } from "./identity.js";

const raw = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  process.stdin.on("error", reject);
});

let headers = {};
try {
  headers = JSON.parse(raw || "{}");
} catch {
  process.stdout.write(JSON.stringify({ verified: false, reason: "malformed_token" }));
  process.exit(0);
}

const identity = await getIdentity({ headers });
if (!identity.verified) {
  process.stdout.write(JSON.stringify({ verified: false, reason: identity.reason || "missing_header" }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  verified: true,
  sub: identity.sub,
  kind: identity.kind,
}));
