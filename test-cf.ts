import { PrismaClient } from '@prisma/client';
import { launchFirefox } from './src/browser/playwright';
import { postSubmitForm } from './src/codeforces/submission';
import { logger } from './src/logger';

const prisma = new PrismaClient();

async function run() {
  console.log('Fetching account from database...');
  const account = await prisma.codeforcesAccount.findFirst({
    where: { handle: 'me_superman' }
  });

  if (!account || !account.sessionCookies) {
    console.error('Account or session cookies not found!');
    return;
  }

  console.log('Launching Firefox with account state...');
  const state = { cookies: account.sessionCookies as any, origins: [] };
  const session = await launchFirefox(state, account.handle);
  
  if (!session) {
    console.error('Failed to launch Firefox!');
    return;
  }

  try {
    const entry = { contestId: 1, problemIndex: 'A', language: 'cpp' };
    const code = `#include<iostream>
using namespace std;
int main(){
long long n,m,a;
cin>>n>>m>>a;
(n%a==0)?n=n/a : n=n/a+1;
(m%a==0)?m=m/a : m=m/a+1;
cout<<n*m<<endl;
return 0;
}`;

    console.log('Testing postSubmitForm locally...');
    const result = await postSubmitForm(session, entry, code);
    console.log('Result:', result);
  } catch (err) {
    console.error('Error during submission:', err);
  } finally {
    console.log('Closing browser...');
    await session.close();
    await prisma.$disconnect();
  }
}

run();
