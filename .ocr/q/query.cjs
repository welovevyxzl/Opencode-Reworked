const Database = require("better-sqlite3");
const db = new Database("C:/Users/Adian Karol Hipsz/.opencode-remote/data.db", { readonly: true });
console.log("--- channel_bindings ---");
for (const r of db.prepare("SELECT * FROM channel_bindings").all()) {
  console.log(JSON.stringify(r));
}
console.log("--- thread_sessions ---");
for (const r of db.prepare("SELECT * FROM thread_sessions").all()) {
  console.log(JSON.stringify(r));
}
console.log("--- queue_items ---");
for (const r of db.prepare("SELECT id, thread_id, project_alias, status FROM queue_items").all()) {
  console.log(JSON.stringify(r));
}
