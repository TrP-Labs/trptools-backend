import webpush from 'web-push'
const keys = webpush.generateVAPIDKeys()
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nBACKGROUND_JOB_TOKEN=${crypto.randomUUID()}${crypto.randomUUID()}\nVAPID_SUBJECT=mailto:YOUR_CONTACT_EMAIL`)
