require('dotenv').config({ path: 'C:/Users/lenovo/Documents/Git/QEDUI/.env' });
const server = require('./server.js');

(async () => {
  try {
    const result = await server.generateAiResponse({
      message: 'formalize handshake lemma',
      code: 'import Mathlib\n\nexample (n : Nat) : n + 0 = n := by\n  simp\n',
      provider: 'academic-cloud'
    });
    console.log('RESULT');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('ERROR');
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
})();
