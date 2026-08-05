#!/usr/bin/env bash
# verify-dns.sh — assert the live zone still matches dns-backup/.
#
#   ./tools/verify-dns.sh [nameserver]
#
# Queries the authoritative nameserver directly rather than a resolver, so a
# stale cache cannot make a broken zone look healthy. Run this after any DNS
# change, and especially after touching proxy status.
#
# The mail records are the point. A missing A record breaks a page loudly and
# you fix it in minutes; a missing DKIM CNAME degrades deliverability silently
# for weeks. Everything here is checked because everything here was migrated.
set -uo pipefail

NS="${1:-olivia.ns.cloudflare.com}"
pass=0; fail=0

chk() { # chk <label> <type> <name> <expected-substring>
  local got
  got=$(dig +short @"$NS" "$2" "$3" | tr -d '\r' | sort | tr '\n' ' ' | sed 's/ *$//')
  if printf '%s' "$got" | grep -qiF "$4"; then
    printf '\033[32m  OK  \033[0m %-34s %s\n' "$1" "$got"; pass=$((pass+1))
  else
    printf '\033[31m FAIL \033[0m %-34s got:[%s] want:[%s]\n' "$1" "$got" "$4"; fail=$((fail+1))
  fi
}

printf '\n\033[1mverifying drkreddy.com against dns-backup, via %s\033[0m\n\n' "$NS"
chk "A     @"          A     drkreddy.com                                 "2.57.91.91"
chk "AAAA  @"          AAAA  drkreddy.com                                 "2a02:4780:84::32"
chk "A     ai"         A     ai.drkreddy.com                              "2.57.91.91"
chk "AAAA  ai"         AAAA  ai.drkreddy.com                              "2a02:4780:84::32"
chk "CNAME www"        CNAME www.drkreddy.com                             "drkreddy.com."
chk "CNAME autoconfig" CNAME autoconfig.drkreddy.com                      "autoconfig.mail.hostinger.com."
chk "CNAME autodisc."  CNAME autodiscover.drkreddy.com                    "autodiscover.mail.hostinger.com."
chk "DKIM  a"          CNAME hostingermail-a._domainkey.drkreddy.com      "hostingermail-a.dkim.mail.hostinger.com."
chk "DKIM  b"          CNAME hostingermail-b._domainkey.drkreddy.com      "hostingermail-b.dkim.mail.hostinger.com."
chk "DKIM  c"          CNAME hostingermail-c._domainkey.drkreddy.com      "hostingermail-c.dkim.mail.hostinger.com."
chk "MX    prio 5"     MX    drkreddy.com                                 "5 mx1.hostinger.com."
chk "MX    prio 10"    MX    drkreddy.com                                 "10 mx2.hostinger.com."
chk "TXT   SPF"        TXT   drkreddy.com                                 "v=spf1 include:_spf.mail.hostinger.com ~all"
chk "TXT   DMARC"      TXT   _dmarc.drkreddy.com                          "v=DMARC1; p=none"

printf '\n\033[1m%d passed, %d failed (14 expected)\033[0m\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
