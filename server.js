const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const config = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI
  },
  sheets: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    apiKey: process.env.GOOGLE_API_KEY,
    sheetName: process.env.SHEET_NAME || "Info Employé"
  }
};

// Trust proxy
app.set('trust proxy', 1);

// Middleware CORS
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-a-changer',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'none'
  }
}));

// ==================== FONCTIONS GOOGLE SHEETS ====================

// Récupérer les données du Google Sheet
async function getSheetData() {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.sheetId}/values/${encodeURIComponent(config.sheets.sheetName)}?key=${config.sheets.apiKey}`;
    
    const response = await axios.get(url);
    return response.data.values || [];
  } catch (error) {
    console.error('❌ Erreur récupération Google Sheet:', error.message);
    return null;
  }
}

// Trouver l'index de l'en-tête
function findHeaderIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].some(cell => 
      cell && (cell.toString().includes("Prénom / Nom") || cell.toString().includes("ID Unique"))
    )) {
      return i;
    }
  }
  return -1;
}

// Chercher un employé par son ID Discord
async function findEmployeeByDiscordId(discordId) {
  const data = await getSheetData();
  
  if (!data) {
    console.log('❌ Impossible de récupérer les données du Sheet');
    return null;
  }

  const headerIndex = findHeaderIndex(data);
  if (headerIndex === -1) {
    console.log('❌ En-tête du Sheet introuvable');
    return null;
  }

  console.log(`🔍 Recherche de l'ID Discord: ${discordId}`);

  // Parcourir les lignes après l'en-tête
  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];
    
    // Colonne G (index 6) = Discord ID
    const sheetDiscordId = row[6] ? row[6].toString().trim() : '';
    
    if (sheetDiscordId === discordId) {
      console.log('✅ Employé trouvé dans le Sheet !');
      
      return {
        nom: row[2] ? row[2].toString().trim() : 'Inconnu', // Colonne C
        grade: row[4] ? row[4].toString().trim() : 'Aucun', // Colonne E
        discordId: sheetDiscordId
      };
    }
  }

  console.log('❌ ID Discord non trouvé dans le Sheet');
  return null;
}

// Déterminer le rôle basé sur le grade
function getRoleFromGrade(grade) {
  const gradeUpper = grade.toUpperCase();
  
  // Admins
  if (gradeUpper.includes('PATRON') || gradeUpper.includes('CO PATRON')) {
    return 'admin';
  }
  
  // RH
  if (gradeUpper.includes('DRH') || gradeUpper.includes('RH')) {
    return 'rh';
  }
  
  // Employés (tous les autres grades)
  if (gradeUpper.includes('RESPONSABLE') || 
      gradeUpper.includes('CHEF') || 
      gradeUpper.includes('CONFIRMÉ') || 
      gradeUpper.includes('MÉCANO') || 
      gradeUpper.includes('APPRENTI') || 
      gradeUpper.includes('STAGIAIRE')) {
    return 'employee';
  }
  
  // Par défaut, visiteur
  return 'visitor';
}

// ==================== ROUTES ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Redirection vers Discord OAuth
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify'  // On a besoin seulement de l'ID !
  });
  
  console.log('🔗 Redirection vers Discord OAuth');
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Callback Discord
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    console.log('❌ Pas de code OAuth');
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }
  
  try {
    console.log('🔄 Échange du code OAuth...');
    
    // 1. Échanger le code contre un token
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.discord.redirectUri
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Token obtenu');
    
    // 2. Récupérer les infos utilisateur Discord
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const discordUser = userResponse.data;
    console.log('✅ Utilisateur Discord:', discordUser.username, '| ID:', discordUser.id);
    
    // 3. Chercher l'utilisateur dans le Google Sheet
    const employee = await findEmployeeByDiscordId(discordUser.id);
    
    if (!employee) {
      console.log('❌ Utilisateur non trouvé dans le Google Sheet');
      return res.redirect(`${process.env.FRONTEND_URL}?error=not_employee`);
    }
    
    console.log('✅ Employé trouvé:', employee.nom, '| Grade:', employee.grade);
    
    // 4. Déterminer le rôle
    const userRole = getRoleFromGrade(employee.grade);
    console.log('✅ Rôle déterminé:', userRole);
    
    // 5. Créer la session
    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      discriminator: discordUser.discriminator || '0',
      avatar: discordUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
      role: userRole,
      employeeName: employee.nom,
      grade: employee.grade
    };
    
    // 6. Sauvegarder la session
    req.session.save((err) => {
      if (err) {
        console.error('❌ Erreur sauvegarde session:', err);
        return res.redirect(`${process.env.FRONTEND_URL}?error=session_error`);
      }
      
      console.log('✅ Session créée pour:', employee.nom, 'avec rôle:', userRole);
      console.log('📝 Session ID:', req.sessionID);
      res.redirect(`${process.env.FRONTEND_URL}?auth=success`);
    });
    
  } catch (error) {
    console.error('❌ Erreur OAuth:', error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// Vérifier l'auth
app.get('/api/check-auth', (req, res) => {
  console.log('🔍 Vérification auth');
  console.log('📝 Session ID:', req.sessionID);
  console.log('👤 Session user:', req.session.user);
  
  if (req.session.user) {
    console.log('✅ Utilisateur authentifié:', req.session.user.employeeName);
    res.json({ authenticated: true, user: req.session.user });
  } else {
    console.log('❌ Pas d\'utilisateur dans la session');
    res.json({ authenticated: false });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Erreur logout:', err);
      return res.status(500).json({ error: 'Erreur' });
    }
    console.log('👋 Déconnexion réussie');
    res.json({ success: true });
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Erreur globale
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ 
    error: 'Erreur serveur interne',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Démarrage
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║  🔥 Paleto Garage - Backend (Google Sheets)   ║
╠════════════════════════════════════════════════╣
║  🚀 Serveur démarré sur le port ${PORT}          ║
║  🌍 Env: ${process.env.NODE_ENV || 'development'}                      ║
╚════════════════════════════════════════════════╝
  `);
  
  // Vérifications
  const warnings = [];
  if (!config.discord.clientId) warnings.push('⚠️  DISCORD_CLIENT_ID manquant');
  if (!config.discord.clientSecret) warnings.push('⚠️  DISCORD_CLIENT_SECRET manquant');
  if (!config.sheets.sheetId) warnings.push('⚠️  GOOGLE_SHEET_ID manquant');
  if (!config.sheets.apiKey) warnings.push('⚠️  GOOGLE_API_KEY manquant');
  
  if (warnings.length > 0) {
    console.log('\n⚠️  AVERTISSEMENTS :');
    warnings.forEach(w => console.log(w));
  } else {
    console.log('✅ Configuration complète\n');
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM reçu. Arrêt du serveur...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT reçu. Arrêt du serveur...');
  process.exit(0);
});
