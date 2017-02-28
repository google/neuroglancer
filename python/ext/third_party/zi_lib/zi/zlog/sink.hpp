//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_ZLOG_SINK_HPP
#define ZI_ZLOG_SINK_HPP 1

#include <zi/zlog/token.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/guard.hpp>

#include <ostream>
#include <deque>

namespace zi {
namespace zlog {

class sink
{
private:
    std::ostream        &out_   ;
    std::deque< token* > tokens_;
    zi::mutex            mutex_ ;

public:
    sink( std::ostream &out ): out_( out ), tokens_(), mutex_()
    {
    }

    token* get_token()
    {
        guard g( mutex_ );
        tokens_.push_back( new token );
        return tokens_.back();
    }

    void token_done( token* t )
    {
        guard g( mutex_ );

        t->mark_done();

        while ( tokens_.size() && tokens_.front()->is_done() )
        {
            out_ << tokens_.front()->out_.str() << std::endl;
            delete tokens_.front();
            tokens_.pop_front();

        }
    }

};

struct token_wrapper: non_copyable
{
private:
    sink  &sink_ ;
    token &token_;

public:

    token_wrapper( sink &s ): sink_( s ), token_( *s.get_token() )
    {
    }

    ~token_wrapper()
    {
        sink_.token_done( &token_ );
    }

    token& get()
    {
        return token_;
    }

};

} // namespace zlog
} // namespace zi

#endif

