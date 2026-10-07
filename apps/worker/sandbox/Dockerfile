# Build only from this tiny trusted context, never from a customer's repository.
# The launcher resolves the resulting image tag to its immutable local image ID.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# No package manager, repository dependency install, or lifecycle script is invoked.
WORKDIR /opt/dogwatch
COPY --chown=10001:10001 sandbox.mjs ./sandbox.mjs

# A numeric identity makes the non-root boundary independent of image account names.
USER 10001:10001
# JSON exec form runs Node directly, with no shell command interpolation.
ENTRYPOINT ["node", "/opt/dogwatch/sandbox.mjs"]
