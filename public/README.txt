Backhoe Rig AR deployment branch

Purpose:
- Cloudflare Workers Static Assets automatic deployment
- Branch: backhoe-rig-ar
- App files live under /public

One-time manual binary upload:
Upload these six split-v3 SPZ files into /public:
01_ground.spz
02_lower.spz
03_upper.spz
04_boom.spz
05_arm.spz
06_bucket.spz

After that, ChatGPT can update the text/code files in this branch and Cloudflare can auto-deploy on push.
