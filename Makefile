#
#  Author: Vlad Seryakov vseryakov@gmail.com
#  Sep 2013
#

all: 
	bin/rc.backend build-backend

run:
	bin/rc.backend run-backend

put:
	bin/rc.backend put-backend

repl:
	bin/rc.backend repl

clean:
	bin/rc.backend clean-backend
	
