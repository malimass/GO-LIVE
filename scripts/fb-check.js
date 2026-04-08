const db = require("better-sqlite3")("/app/data/go-live.db");
const rows = db.prepare("SELECT page_id, page_access_token FROM facebook_destinations WHERE enabled=1").all();
(async () => {
  for (const r of rows) {
    console.log("Checking page", r.page_id);
    const res = await fetch("https://graph.facebook.com/v19.0/" + r.page_id + "/live_videos?status=[LIVE_NOW,LIVE_STOPPED]&fields=id,title,status&access_token=" + r.page_access_token);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  }
})();
