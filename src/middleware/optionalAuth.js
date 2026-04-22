const jwt = require('jsonwebtoken');

module.exports = function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    } catch {
      // token non valido — procedi come utente anonimo
    }
  }
  next();
};
