import { hashSync } from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('usage: pnpm hash-password <password>');
  process.exit(1);
}
console.log(hashSync(password, 10));
