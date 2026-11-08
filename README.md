# Survive or Die – relay server

A small Node.js server for online games. The GameMaker game is the host. Players join on their phones at this server's web address with a 4-letter room code.

## Deploy on Render

1. Put this folder in a GitHub repository. Upload `package.json`, `server.js`, `README.md` and the `public` folder.
2. In Render, choose **New → Web Service** and pick that repository.
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
3. After it deploys, open `https://<your-service>.onrender.com/health`. It should say `ok`.

Players join at `https://<your-service>.onrender.com`.
