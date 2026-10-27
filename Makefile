include puddle.mk

.PHONY: test
test: ## Run every extension test
	$(DENO) test --allow-read --allow-write extensions/models/
