import { migrate } from "../src/lib/migrate";

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error("Set DATABASE_OWNER_URL to a connection string for the database owner (not the fettle_app role).");
  process.exit(1);
}
migrate(url).then(
  (applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date."),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
