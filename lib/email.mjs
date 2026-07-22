export async function sendEmail({to,subject,html,idempotencyKey}){
  if(!process.env.RESEND_API_KEY){ console.log('[email preview]',{to,subject,idempotencyKey}); return {id:`preview-${Date.now()}`}; }
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],reply_to:process.env.EMAIL_REPLY_TO||undefined,subject,html})});
  if(!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`); return r.json();
}
