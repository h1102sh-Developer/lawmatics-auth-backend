const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const CREDENTIALS = require('./client_secret_826700607010-8dd22ba29nt3b8rflnjsons9rnoq4sm3.apps.googleusercontent.com.json');
const { client_secret, client_id, redirect_uris } = CREDENTIALS.web;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline', // VERY IMPORTANT to get a refresh token
  scope: SCOPES,
});

console.log('Authorize this app by visiting this url:', authUrl);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter the code from that page here: ', async (code) => {
  rl.close();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));
  console.log('✅ Token stored to token.json');
});
