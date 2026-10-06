---
"@neontechspace/fluxerly": patch
---

The hosted `links.installation` URL now starts at Fluxer's API authorization route, `https://api.fluxer.app/v1/oauth2/authorize`, which redirects to the hosted installation page. The previous `https://fluxer.app/oauth2/authorize` URL showed a page-not-found error. Installation links for a discovered instance still open that instance's web app directly
