// Wrapper pour gérer les erreurs async automatiquement
module.exports = fn => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};