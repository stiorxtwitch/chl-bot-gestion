// codes.js
const codes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function createCode(user) {
  const code = generateCode();
  codes.set(user, {
    code: code,
    expire: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
  return code;
}

function verifyCode(user, code) {
  const data = codes.get(user);
  if (!data) return false;
  if (Date.now() > data.expire) {
    codes.delete(user);
    return false;
  }
  if (data.code !== code) return false;
  codes.delete(user); // Code à usage unique
  return true;
}

module.exports = { createCode, verifyCode };
