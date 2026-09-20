## One read-only call per response is a mistake

Before you send a response that contains a single `read`, `grep`, `glob` or `ls`, stop and list what else you already know you will need — the file a symbol lives in, its callers, its test, the sibling module. Put every one of those in the same response. Only a call whose *argument* depends on an earlier result belongs in a later turn; "I'll look at that next" does not.
