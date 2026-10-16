# Generated app

Node.js + Express + Prisma (PostgreSQL) API in `server/`, React + Vite + Tailwind UI in `client/`.

```bash
npm install
cp server/.env.example server/.env   # if server/.env is missing
npm run setup        # start PostgreSQL (Docker), apply migrations, seed data
npm test             # API tests (use TEST_DATABASE_URL, which is wiped each run)
npm run build        # build the React app
npm start            # http://localhost:3001 (API + built UI)

# development (two terminals)
npm run dev:server   # API on :3001
npm run dev:client   # UI on :5173, /api proxied to :3001
```

Data model: `server/prisma/schema.prisma`. Browse the data: `npm run db:studio -w server`.
After changing the schema: `npx prisma migrate dev --name <change>` (in `server/`).
