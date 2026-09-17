# Gujjar Penthouse

A shared expense tracker + group chat, built for the roommates of Gujjar Penthouse.

- Anyone can sign up with a name + password
- Add expenses and split them between chosen roommates
- See who owes whom (auto-calculated)
- Group chat, saved so history is there when you come back

## Running it locally (for testing on your own PC)

Easiest way: double-click `start-app.bat`. It installs everything it needs
the first time (takes a minute), then starts the app. Keep that window open
while you use the app; close it to stop the app.

Manual way, if you prefer a terminal:
1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 in your browser.

Data is stored in a `data/app.json` file next to `server.js` — it's created automatically.

## Deploying so all roommates can use it

See the setup guide provided alongside this project for step-by-step instructions
(using Railway.app, free, with a persistent volume so your data is never lost).
