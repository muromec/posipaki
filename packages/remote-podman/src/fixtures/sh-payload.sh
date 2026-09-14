# ── a payload that is not JavaScript ───────────────────────────────────────
#
# A runtime is whatever `command -v` finds, so a payload only has to be a file the
# runtime can run.  This one answers the wire in POSIX sh: hello, one state
# snapshot, an echo per message, and an exit frame when it is told to go.  It is
# what the integration test stages into a real container, so the image needs a
# shell and nothing else.

printf '{"$proto":"json.v1"}\n'
while IFS= read -r line; do
  case "$line" in
    *'"$init"'*) printf '{"$state":{"said":true}}\n' ;;
    *'"BYE"'*) printf '{"$exit":{"code":0,"state":{"said":true}}}\n'; exit 0 ;;
    *) printf '{"$msg":{"fromName":"sh-payload","body":{"echo":"pong"}}}\n' ;;
  esac
done
