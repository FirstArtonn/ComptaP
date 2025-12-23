// ==================== SERVER.JS ====================
// Backend Node.js pour l'authentification Discord OAuth2

const express = require('express');
const session = require('express-session');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const config = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
    guildId: process.env.DISCORD_GUILD_ID,
    botToken: process.env.DISCORD_BOT_TOKEN
  },
  roles: {
    ADMIN: process.env.ADMIN_ROLES.split(','),
    RH: process.env.RH_ROLES.split(','),
    EMPLOYEE: process.env.EMPLOYEE_ROLES.split(',')
  }
};

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8080',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session avec secret sécurisé
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-a-changer',
  resave: false,
  saveUninitialized: false,
  proxy: true, // ← AJOUTEZ CECI
  cookie: {
    secure: true, // ← FORCEZ true au lieu de vérifier NODE_ENV
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'none', // ← Laissez 'none'
    domain: '.railway.app' // ← AJOUTEZ CECI
  }
}));

// ==================== MIDDLEWARE D'AUTHENTIFICATION ====================
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
};

const requireRole = (minRole) => {
  const roleHierarchy = { 'admin': 3, 'rh': 2, 'employee': 1, 'visitor': 0 };
  
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    
    const userLevel = roleHierarchy[req.session.user.role] || 0;
    const requiredLevel = roleHierarchy[minRole] || 0;
    
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: 'Permissions insuffisantes' });
    }
    
    next();
  };
};

// ==================== FONCTIONS UTILITAIRES ====================

// Déterminer le rôle de l'utilisateur basé sur ses rôles Discord
function determineUserRole(discordRoles) {
  if (!discordRoles || !Array.isArray(discordRoles)) {
    return 'visitor';
  }
  
  // Vérifier admin
  if (config.roles.ADMIN.some(roleId => discordRoles.includes(roleId))) {
    return 'admin';
  }
  
  // Vérifier RH
  if (config.roles.RH.some(roleId => discordRoles.includes(roleId))) {
    return 'rh';
  }
  
  // Vérifier employé
  if (config.roles.EMPLOYEE.some(roleId => discordRoles.includes(roleId))) {
    return 'employee';
  }
  
  return 'visitor';
}

// Récupérer les infos d'un membre du serveur Discord
async function getGuildMember(userId) {
  try {
    const response = await axios.get(
      `https://discord.com/api/guilds/${config.discord.guildId}/members/${userId}`,
      {
        headers: {
          'Authorization': `Bot ${config.discord.botToken}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Erreur récupération membre:', error.response?.data || error.message);
    return null;
  }
}

// ==================== ROUTES D'AUTHENTIFICATION ====================

// Redirection vers Discord OAuth
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify guilds guilds.members.read'
  });
  
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Callback Discord OAuth
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }
  
  try {
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
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    
    // 2. Récupérer les infos utilisateur
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    const user = userResponse.data;
    
    // 3. Récupérer les rôles du membre dans le serveur
    const member = await getGuildMember(user.id);
    
    if (!member) {
      return res.redirect(`${process.env.FRONTEND_URL}?error=not_in_guild`);
    }
    
    // 4. Déterminer le rôle de l'utilisateur
    const userRole = determineUserRole(member.roles);
    
    // 5. Créer la session utilisateur
    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar 
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator) % 5}.png`,
      role: userRole,
      roles: member.roles
    };
    
    // 6. Sauvegarder la session
    req.session.save((err) => {
      if (err) {
        console.error('Erreur sauvegarde session:', err);
        return res.redirect(`${process.env.FRONTEND_URL}?error=session_error`);
      }
      
      // 7. Rediriger vers le frontend avec succès
      res.redirect(`${process.env.FRONTEND_URL}?auth=success`);
    });
    
  } catch (error) {
    console.error('Erreur OAuth:', error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// Récupérer les infos de l'utilisateur connecté
app.get('/api/user', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: req.session.user
  });
});

// Déconnexion
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Erreur déconnexion' });
    }
    res.json({ success: true, message: 'Déconnecté avec succès' });
  });
});

// Vérifier l'authentification (pour le frontend)
app.get('/api/check-auth', (req, res) => {
  if (req.session.user) {
    res.json({ 
      authenticated: true, 
      user: req.session.user 
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ==================== ROUTES PROTÉGÉES (EXEMPLES) ====================

// Route accessible uniquement aux employés et plus
app.get('/api/employees', requireRole('employee'), (req, res) => {
  // Ici vous pouvez ajouter votre logique pour récupérer les employés
  res.json({
    success: true,
    message: 'Liste des employés (connecté avec Google Sheets)',
    user: req.session.user
  });
});

// Route accessible uniquement aux RH et admins
app.get('/api/recruitment', requireRole('rh'), (req, res) => {
  res.json({
    success: true,
    message: 'Liste des candidats',
    user: req.session.user
  });
});

// Route accessible uniquement aux admins
app.post('/api/admin/action', requireRole('admin'), (req, res) => {
  res.json({
    success: true,
    message: 'Action admin effectuée',
    user: req.session.user
  });
});

// ==================== ROUTES DE TEST ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test de configuration (désactiver en production)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/config', (req, res) => {
    res.json({
      discord: {
        clientId: config.discord.clientId,
        redirectUri: config.discord.redirectUri,
        guildId: config.discord.guildId,
        hasClientSecret: !!config.discord.clientSecret,
        hasBotToken: !!config.discord.botToken
      },
      roles: config.roles,
      session: {
        authenticated: !!req.session.user,
        user: req.session.user?.username || 'Non connecté'
      }
    });
  });
}

// ==================== GESTION DES ERREURS ====================

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

// ==================== DÉMARRAGE DU SERVEUR ====================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║  🔥 Paleto Garage - Backend Auth Discord      ║
╠════════════════════════════════════════════════╣
║  🚀 Serveur démarré sur le port ${PORT}         ║
║  🌍 Environnement: ${process.env.NODE_ENV || 'development'}              ║
║  🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:8080'}  ║
╚════════════════════════════════════════════════╝
  `);
  
  // Vérifications au démarrage
  const warnings = [];
  
  if (!config.discord.clientId) warnings.push('⚠️  DISCORD_CLIENT_ID manquant');
  if (!config.discord.clientSecret) warnings.push('⚠️  DISCORD_CLIENT_SECRET manquant');
  if (!config.discord.botToken) warnings.push('⚠️  DISCORD_BOT_TOKEN manquant');
  if (!config.discord.guildId) warnings.push('⚠️  DISCORD_GUILD_ID manquant');
  
  if (warnings.length > 0) {
    console.log('\n⚠️  AVERTISSEMENTS :');
    warnings.forEach(w => console.log(w));
    console.log('\n');
  } else {
    console.log('✅ Configuration complète\n');
  }
});

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu. Arrêt du serveur...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT reçu. Arrêt du serveur...');
  process.exit(0);
});
