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

#ifndef ZI_ZLOG_REGISTRY_HPP
#define ZI_ZLOG_REGISTRY_HPP 1

#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/guard.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/enable_singleton_of_this.hpp>

#include <string>
#include <map>

namespace zi {
namespace zlog {

class registry: enable_singleton_of_this< registry >
{
private:
    zi::mutex                      mutex_;
    std::map< std::string, bool* > logs_;
    bool                           true_;
    bool                           false_;

    inline const bool* is_active_( const std::string &name ) const
    {
        guard g( mutex_ );

        std::map< std::string, bool* >::const_iterator it = logs_.find( name );

        if ( it != logs_.end() )
        {
            return it->second;
        }

        return &false_;
    }

public:

    registry(): mutex_(), logs_(), true_( true ), false_( false )
    {
        register_log( "default", &true_ );
    }

    void register_log( const std::string &name, bool* flag )
    {
        guard g( mutex_ );
        logs_[ name ] = flag;
    }

    static inline const bool* is_active( const std::string &name )
    {
        static const registry& registry_ = registry::instance();
        return registry_.is_active_( name );
    }

    struct signup
    {
        signup( const std::string &name, bool* value )
        {
            registry::instance().register_log( name, value );
        }
    };

};

} // namespace zlog
} // namespace zi

#endif

