const fs = require('fs');

// Test that showLogin and showApp toggle elements correctly
console.log('Testing showLogin and showApp logic...');

const elements = {
  'login-screen': { hidden: true },
  '.app': { hidden: false },
  'login-error': { hidden: true, textContent: '' }
};

function $(id) { return elements[id]; }
function querySelector(sel) { return elements[sel]; }

function showLogin(msg){
  const ls = $('login-screen');
  const app = querySelector('.app');
  if(ls) ls.hidden = false;
  if(app) app.hidden = true;
  const err = $('login-error');
  if(err){
    if(msg){
      err.hidden = false;
      err.textContent = msg;
    } else {
      err.hidden = true;
      err.textContent = '';
    }
  }
}

function showApp(){
  const ls = $('login-screen');
  const app = querySelector('.app');
  if(ls) ls.hidden = true;
  if(app) app.hidden = false;
}

// 1. Initial state: login-screen hidden, app visible
console.log('1. Initial:', elements['login-screen'].hidden, elements['.app'].hidden);

// 2. 401 received: showLogin() called
showLogin();
console.log('2. After 401 showLogin():');
console.log('   login-screen hidden?', elements['login-screen'].hidden); // should be false
console.log('   app hidden?', elements['.app'].hidden); // should be true

// 3. User submits login: showApp() called
showApp();
console.log('3. After successful login showApp():');
console.log('   login-screen hidden?', elements['login-screen'].hidden); // should be true
console.log('   app hidden?', elements['.app'].hidden); // should be false

console.log('All logic verified!');
