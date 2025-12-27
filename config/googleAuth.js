// config/googleAuth.js

function getOAuthCredentials() {
    return {
      web: {
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        project_id: process.env.GOOGLE_OAUTH_PROJECT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        redirect_uris: process.env.GOOGLE_OAUTH_REDIRECT_URIS ? 
          process.env.GOOGLE_OAUTH_REDIRECT_URIS.split(',') : 
          ["http://localhost:3000/oauth2callback"]
      }
    };
  }
  // Add this function to your existing config/googleAuth.js file
function getTokenCredentials() {
    // Check if we have token data in environment variables
    if (process.env.GOOGLE_TOKEN_JSON) {
      return JSON.parse(process.env.GOOGLE_TOKEN_JSON);
    }
    
    // Fallback to file system (for local development)
    const TOKEN_PATH = path.join(__dirname, '../token.json');
    if (fs.existsSync(TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    }
    
    return null;
  }
  function getServiceAccountCredentials() {
    // Replace actual newlines with \n in the private key
    const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n');
    
    return {
      type: process.env.GOOGLE_SERVICE_ACCOUNT_TYPE,
      project_id: process.env.GOOGLE_SERVICE_ACCOUNT_PROJECT_ID,
      private_key_id: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_ID,
      auth_uri: process.env.GOOGLE_SERVICE_ACCOUNT_AUTH_URI,
      token_uri: process.env.GOOGLE_SERVICE_ACCOUNT_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.GOOGLE_SERVICE_ACCOUNT_AUTH_PROVIDER_CERT_URL,
      client_x509_cert_url: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_CERT_URL,
      universe_domain: process.env.GOOGLE_SERVICE_ACCOUNT_UNIVERSE_DOMAIN
    };
  }
  
  module.exports = {
    getOAuthCredentials,
    getTokenCredentials,
    getServiceAccountCredentials
  };